#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)][string]$Manifest,
    [string]$OutputPath,
    [ValidateRange(1, 3600)][int]$TimeoutSec = 60,
    [ValidateRange(1, 1024)][int]$MaxFileMB = 256,
    [switch]$OnlyFailed
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Get-Property($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -ne $property) { return $property.Value }
    return $null
}

function Read-MediaList([string]$Path, [bool]$FailuresOnly) {
    $text = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8).Trim()
    $pageUrl = ''
    if ([IO.Path]::GetExtension($Path) -ieq '.csv') {
        $items = @(Import-Csv -LiteralPath $Path -Encoding UTF8)
    } elseif ($text.StartsWith('{') -or $text.StartsWith('[')) {
        $document = ConvertFrom-Json -InputObject $text
        if ($text.StartsWith('{')) {
            $pageUrl = [string](Get-Property $document 'pageUrl')
            $items = Get-Property $document 'items'
            if ($null -eq $items) { $items = Get-Property $document 'results' }
            if ($null -eq $items) { throw 'JSON에 items 또는 results 목록이 없습니다.' }
        } else { $items = @($document) }
    } else {
        $items = @($text -split '\r?\n' | Where-Object { $_.Trim() -and -not $_.TrimStart().StartsWith('#') })
    }
    $jobs = [Collections.Generic.List[object]]::new()
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $nextOrder = 0
    foreach ($item in $items) {
        $sourceOrder = Get-Property $item 'order'
        $declaredOrder = 0
        if ([int]::TryParse([string]$sourceOrder, [ref]$declaredOrder) -and
                $declaredOrder -gt $nextOrder -and $declaredOrder -le 100000000) {
            $nextOrder = $declaredOrder
        } else { $nextOrder++ }
        if ($FailuresOnly -and (Get-Property $item 'status') -notin @('failed', 'skipped')) { continue }
        $url = if ($item -is [string]) { $item.Trim() } else { [string](Get-Property $item 'url') }
        $url = $url.Trim()
        if (-not $url) { throw 'URL이 없는 항목이 있습니다.' }
        if (-not $seen.Add($url)) { continue }
        $jobs.Add([pscustomobject]@{ order = $nextOrder; source_order = $sourceOrder; url = $url })
    }
    if ($jobs.Count -eq 0) { throw '다운로드할 주소가 없습니다. -OnlyFailed는 실패 상태가 있는 리포트에 사용하세요.' }
    return @{ jobs = $jobs.ToArray(); pageUrl = $pageUrl }
}

function Get-OriginReferer([string]$PageUrl) {
    $uri = $null
    if ([Uri]::TryCreate($PageUrl, [UriKind]::Absolute, [ref]$uri) -and
            $uri.Scheme -in @('http', 'https') -and -not $uri.UserInfo) {
        return $uri.GetLeftPart([UriPartial]::Authority) + '/'
    }
    return ''
}

function Get-DataBytes([string]$Url) {
    $comma = $Url.IndexOf(',')
    if ($comma -lt 0) { throw '잘못된 data 주소입니다.' }
    $header = $Url.Substring(5, $comma - 5)
    if ($header -notmatch '^(image|video)/') { throw '이미지·영상이 아닌 data 주소입니다.' }
    $payload = $Url.Substring($comma + 1)
    if ($header -match '(?i)(?:^|;)base64(?:;|$)') {
        $encoded = [Uri]::UnescapeDataString($payload) -replace '\s', ''
        $encoded = $encoded.PadRight($encoded.Length + (4 - $encoded.Length % 4) % 4, '=')
        return ,([Convert]::FromBase64String($encoded))
    }
    $bytes = [Collections.Generic.List[byte]]::new()
    foreach ($part in [regex]::Split($payload, '(%[0-9A-Fa-f]{2})')) {
        if ($part -match '^%[0-9A-Fa-f]{2}$') { $bytes.Add([Convert]::ToByte($part.Substring(1), 16)) }
        else { $bytes.AddRange([Text.Encoding]::UTF8.GetBytes($part)) }
    }
    return ,($bytes.ToArray())
}

function Test-Bytes([byte[]]$Bytes, [byte[]]$Signature) {
    if ($Bytes.Length -lt $Signature.Length) { return $false }
    for ($i = 0; $i -lt $Signature.Length; $i++) { if ($Bytes[$i] -ne $Signature[$i]) { return $false } }
    return $true
}

function Get-Ascii([byte[]]$Bytes, [int]$Start, [int]$Count) {
    if ($Start -ge $Bytes.Length) { return '' }
    return [Text.Encoding]::ASCII.GetString($Bytes, $Start, [Math]::Min($Count, $Bytes.Length - $Start))
}

function Get-MediaExtension([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    try {
        $buffer = [byte[]]::new(16384)
        $count = $stream.Read($buffer, 0, $buffer.Length)
        $bytes = [byte[]]::new($count)
        [Array]::Copy($buffer, $bytes, $count)
    } finally { $stream.Dispose() }
    if (Test-Bytes $bytes ([byte[]]@(255,216,255))) { return '.jpg' }
    if (Test-Bytes $bytes ([byte[]]@(137,80,78,71,13,10,26,10))) { return '.png' }
    if ((Get-Ascii $bytes 0 6) -in @('GIF87a','GIF89a')) { return '.gif' }
    if ((Get-Ascii $bytes 0 4) -eq 'RIFF') {
        if ((Get-Ascii $bytes 8 4) -eq 'WEBP') { return '.webp' }
        if ((Get-Ascii $bytes 8 4) -eq 'AVI ') { return '.avi' }
    }
    if ((Test-Bytes $bytes ([byte[]]@(73,73,42,0))) -or (Test-Bytes $bytes ([byte[]]@(77,77,0,42))) -or
            (Test-Bytes $bytes ([byte[]]@(73,73,43,0))) -or (Test-Bytes $bytes ([byte[]]@(77,77,0,43)))) { return '.tiff' }
    if ((Get-Ascii $bytes 0 2) -eq 'BM' -and $bytes.Length -ge 14) { return '.bmp' }
    if ((Test-Bytes $bytes ([byte[]]@(0,0,1,0))) -and $bytes.Length -ge 6) { return '.ico' }
    if ((Get-Ascii $bytes 4 4) -eq 'ftyp') {
        $boxSize = [uint64]$bytes[0] * 16777216 + [uint64]$bytes[1] * 65536 + [uint64]$bytes[2] * 256 + $bytes[3]
        $brands = [Collections.Generic.List[string]]::new()
        $brands.Add((Get-Ascii $bytes 8 4))
        for ($i = 16; $i + 4 -le [Math]::Min($bytes.Length, $boxSize); $i += 4) { $brands.Add((Get-Ascii $bytes $i 4)) }
        if (@($brands | Where-Object { $_ -in @('avif','avis') }).Count) { return '.avif' }
        if (@($brands | Where-Object { $_ -in @('heic','heix','hevc','hevx') }).Count) { return '.heic' }
        if (@($brands | Where-Object { $_ -in @('mif1','msf1') }).Count) { return '.heif' }
        if ($brands.Contains('qt  ')) { return '.mov' }
        return '.mp4'
    }
    if (Test-Bytes $bytes ([byte[]]@(26,69,223,163))) {
        if ((Get-Ascii $bytes 0 4096).Contains('webm')) { return '.webm' }
        return '.mkv'
    }
    if ((Get-Ascii $bytes 0 4) -eq 'OggS') { return '.ogv' }
    if ((Test-Bytes $bytes ([byte[]]@(0,0,1,186))) -or (Test-Bytes $bytes ([byte[]]@(0,0,1,179)))) { return '.mpeg' }
    $text = [Text.Encoding]::UTF8.GetString($bytes).TrimStart([char[]]@([char]0xfeff,' ',"`t","`r","`n"))
    if ($text.StartsWith('#EXTM3U')) { return '.m3u8' }
    $text = [regex]::Replace($text, '^<\?xml\b[\s\S]*?\?>\s*', '')
    while ($text.StartsWith('<!--') -and $text.Contains('-->')) { $text = $text.Substring($text.IndexOf('-->') + 3).TrimStart() }
    $text = [regex]::Replace($text, '^<!DOCTYPE\s+svg\b[^>]*>\s*', '', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($text -cmatch '^<svg(?:\s|>)') { return '.svg' }
    if ($text -cmatch '^<(?:[\w.-]+:)?MPD(?:\s|>)') { return '.mpd' }
    return $null
}

function Complete-HttpTask($Task, $Cancel, [Diagnostics.Stopwatch]$Clock) {
    $remaining = [int][Math]::Ceiling($TimeoutSec * 1000 - $Clock.Elapsed.TotalMilliseconds)
    if ($remaining -le 0 -or (-not $Task.IsCompleted -and -not $Task.Wait($remaining))) {
        $Cancel.Cancel()
        throw '요청 대기 시간을 넘었습니다.'
    }
    return $Task.GetAwaiter().GetResult()
}

function Receive-Media($Job, [string]$Folder, [int]$Width, $Client, [string]$Referer, [long]$Limit) {
    $result = [pscustomobject][ordered]@{ order = $Job.order; source_order = $Job.source_order; status = 'failed';
        filename = ''; bytes = 0; http_status = ''; content_type = ''; url = $Job.url; message = '' }
    $temporary = $null; $response = $null; $request = $null; $cancel = $null
    try {
        $uri = $null
        $isData = $Job.url.StartsWith('data:', [StringComparison]::OrdinalIgnoreCase)
        if (-not $isData) {
            if (-not [Uri]::TryCreate($Job.url, [UriKind]::Absolute, [ref]$uri)) { throw '올바른 절대 URL이 아닙니다.' }
            if ($uri.Scheme -notin @('http','https')) {
                $result.status = 'skipped'; $result.message = 'http·https·data 주소만 지원합니다. blob은 브라우저 세션 주소입니다.'
                return $result
            }
            if ($uri.Host -eq 'mercury.coupang.com' -and $uri.AbsolutePath -ceq '/e.gif') {
                $result.status = 'skipped'; $result.message = '통계·이벤트 요청 주소입니다.'; return $result
            }
            if ($uri.UserInfo) { throw '계정 정보가 포함된 주소는 지원하지 않습니다.' }
        }
        $temporary = [IO.Path]::Combine($Folder, '.media-' + [Guid]::NewGuid().ToString('N') + '.part')
        if ($isData) {
            $data = Get-DataBytes $Job.url
            if ($data.LongLength -gt $Limit) { throw '파일 크기 제한을 넘었습니다.' }
            [IO.File]::WriteAllBytes($temporary, $data)
            $result.content_type = ($Job.url.Substring(5) -split '[;,]', 2)[0]
        } else {
            $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, $uri)
            if ($Referer) { $request.Headers.Referrer = [Uri]$Referer }
            $cancel = [Threading.CancellationTokenSource]::new()
            $clock = [Diagnostics.Stopwatch]::StartNew()
            $cancel.CancelAfter([TimeSpan]::FromSeconds($TimeoutSec))
            $response = Complete-HttpTask ($Client.SendAsync($request, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cancel.Token)) $cancel $clock
            $result.http_status = [int]$response.StatusCode
            $result.content_type = [string]$response.Content.Headers.ContentType
            if (-not $response.IsSuccessStatusCode) { throw ('HTTP {0}: {1}' -f $result.http_status, $response.ReasonPhrase) }
            $length = $response.Content.Headers.ContentLength
            if ($null -ne $length -and $length -gt $Limit) { throw '파일 크기 제한을 넘었습니다.' }
            $inputStream = Complete-HttpTask ($response.Content.ReadAsStreamAsync()) $cancel $clock
            try {
                $outputStream = [IO.File]::Create($temporary)
                try {
                    $buffer = [byte[]]::new(65536); $received = [long]0
                    while (($read = Complete-HttpTask ($inputStream.ReadAsync($buffer, 0, $buffer.Length, $cancel.Token)) $cancel $clock) -gt 0) {
                        $received += $read
                        if ($received -gt $Limit) { throw '파일 크기 제한을 넘었습니다.' }
                        $outputStream.Write($buffer, 0, $read)
                    }
                    if ($null -ne $length -and $received -ne $length) { throw '응답이 중간에 끊겼습니다.' }
                } finally { $outputStream.Dispose() }
            } finally { $inputStream.Dispose() }
        }
        $extension = Get-MediaExtension $temporary
        if (-not $extension) { throw '지원하는 미디어 형식이 아닙니다. OK·HTML·JSON 또는 손상된 응답일 수 있습니다.' }
        $result.filename = $Job.order.ToString(('D' + $Width)) + $extension
        $target = [IO.Path]::Combine($Folder, $result.filename)
        [IO.File]::Move($temporary, $target); $temporary = $null
        $result.bytes = ([IO.FileInfo]$target).Length
        $result.status = if ($extension -in @('.m3u8','.mpd')) { 'playlist' } else { 'saved' }
        if ($result.status -eq 'playlist') { $result.message = '재생목록만 저장했습니다. 영상 조각을 합치지는 않습니다.' }
    } catch {
        $result.filename = ''
        $result.message = if ($null -ne $cancel -and $cancel.IsCancellationRequested) { '요청 대기 시간을 넘었습니다.' } else { $_.Exception.Message }
    } finally {
        if ($null -ne $response) { $response.Dispose() }
        if ($null -ne $request) { $request.Dispose() }
        if ($null -ne $cancel) { $cancel.Dispose() }
        if ($null -ne $temporary -and [IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
    return $result
}

function Write-ReportCSV([string]$Path, [object[]]$Rows) {
    $fields = @('order','source_order','status','filename','bytes','http_status','content_type','url','message')
    $lines = if ($Rows.Count) { @($Rows | Select-Object -Property $fields | ConvertTo-Csv -NoTypeInformation) }
             else { @('"' + ($fields -join '","') + '"') }
    [IO.File]::WriteAllText($Path, ($lines -join "`r`n") + "`r`n", [Text.UTF8Encoding]::new($true))
}

$client = $null; $handler = $null
try {
    $sourcePath = [IO.Path]::GetFullPath($Manifest)
    $inputList = Read-MediaList $sourcePath ([bool]$OnlyFailed)
    $jobs = $inputList.jobs
    $folder = if ($OutputPath) { [IO.Path]::GetFullPath($OutputPath) } else {
        [IO.Path]::Combine([IO.Path]::GetDirectoryName($sourcePath), 'download-output',
            (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,6))
    }
    if ([IO.Directory]::Exists($folder) -or [IO.File]::Exists($folder)) { throw '저장 폴더가 이미 존재합니다. 새 폴더를 지정하세요.' }
    [void][IO.Directory]::CreateDirectory($folder)
    Add-Type -AssemblyName System.Net.Http
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.UseCookies = $false
    $handler.AllowAutoRedirect = $true
    $handler.MaxAutomaticRedirections = 10
    $handler.AutomaticDecompression = [Net.DecompressionMethods]::GZip -bor [Net.DecompressionMethods]::Deflate
    $client = [Net.Http.HttpClient]::new($handler)
    $client.Timeout = [Threading.Timeout]::InfiniteTimeSpan
    $client.DefaultRequestHeaders.UserAgent.ParseAdd('ScraperMediaDownloader/1.0')
    $referer = Get-OriginReferer $inputList.pageUrl
    $width = [Math]::Max(4, ([string]$jobs[-1].order).Length)
    $results = [Collections.Generic.List[object]]::new()
    $limit = [long]$MaxFileMB * 1MB
    Write-Host ('총 {0}개 / 순서대로 다운로드 / 저장 폴더: {1}' -f $jobs.Count, $folder)
    foreach ($job in $jobs) {
        $result = Receive-Media $job $folder $width $client $referer $limit
        $results.Add($result)
        Write-Host ('[{0}/{1}] #{2} {3} {4}' -f $results.Count, $jobs.Count, $job.order, $result.status,
            $(if ($result.filename) { $result.filename } else { $result.message }))
    }
    $all = $results.ToArray()
    Write-ReportCSV ([IO.Path]::Combine($folder,'download-report.csv')) $all
    Write-ReportCSV ([IO.Path]::Combine($folder,'failed.csv')) @($all | Where-Object { $_.status -in @('failed','skipped') })
    $report = [ordered]@{ pageUrl = $inputList.pageUrl; results = $all }
    [IO.File]::WriteAllText([IO.Path]::Combine($folder,'download-report.json'),
        (ConvertTo-Json -InputObject $report -Depth 8) + "`r`n", [Text.UTF8Encoding]::new($false))
    $saved = @($all | Where-Object { $_.status -eq 'saved' }).Count
    $playlists = @($all | Where-Object { $_.status -eq 'playlist' }).Count
    $failed = $all.Length - $saved - $playlists
    Write-Host ('완료: 파일 {0}개 / 재생목록 {1}개 / 실패·건너뜀 {2}개' -f $saved,$playlists,$failed)
    Write-Host ('실패 기록: ' + [IO.Path]::Combine($folder,'failed.csv'))
    if ($failed) { exit 2 }
    exit 0
} catch {
    Write-Host ('실행 실패: ' + $_.Exception.Message)
    exit 1
} finally {
    if ($null -ne $client) { $client.Dispose() }
    if ($null -ne $handler) { $handler.Dispose() }
}
