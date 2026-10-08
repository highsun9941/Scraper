# Scraper

쇼핑 상품 페이지에서 이미지·GIF·동영상 주소를 수집하는 브라우저 콘솔 스크립트입니다.
페이지의 DOM, CSS 이미지 주소와 현재 남아 있는 Resource Timing 항목을 읽고, 정확히 같은 URL을 중복 제거합니다.
페이지 내부 SVG 참조와 확인된 통계·이벤트 주소는 미디어 목록에서 제외합니다.
결과는 페이지 전체의 **위 → 아래, 같은 높이에서는 왼쪽 → 오른쪽** 순서로 정렬합니다.
Windows 기본 PowerShell로 목록에 있는 파일을 일괄 다운로드할 수 있습니다. **추가 설치는 필요하지 않습니다.**
브라우저에서 읽을 수 있는 원본 파일은 콘솔 명령으로 ZIP에 묶어 다운로드하는 방식도 지원합니다.
Python 다운로드 도구는 선택 사항입니다.
유튜브 임베드는 `EMBED`로 기록합니다. 쿠팡 리뷰는 페이지 데이터와 리뷰 목록 응답에 있는 원본 영상 주소를 **재생 없이** 수집합니다.
재생창의 동적 영상 주소도 스크립트 실행 후 자동 감시합니다.
H.264·AAC TS 방식의 HLS 리뷰 영상은 콘솔에서 `await mediaGrab.downloadHls()`로 MP4 ZIP에 저장할 수 있습니다. Python이나 FFmpeg 실행 파일을 설치할 필요가 없습니다.

## 윈도우에서 실행하기

1. 이 저장소의 **Code → Download ZIP**으로 내려받고 압축을 풉니다.
2. Chrome 또는 Edge에서 테스트할 상품 페이지를 엽니다.
3. `상품 정보 더보기`, `상세정보 펼쳐보기` 등을 눌러 상세내용을 전부 펼칩니다. 페이지를 끝까지 스크롤하고, 필요한 갤러리·팝업도 열어 미디어가 로딩되게 합니다.
4. `collect-page-media.js`를 텍스트 편집기로 열고 전체 코드를 복사합니다.
5. 상품 페이지에서 `F12`를 누르고 **Console** 탭에 코드를 붙여 넣은 뒤 Enter를 누릅니다.
6. 콘솔의 표와 `총 N개 URL` 로그를 확인합니다.

`collect-page-media.js`는 상품 페이지 안에서 실행하는 코드입니다. 실행할 페이지의 `window`와 `document`를 사용합니다.
한 번 실행하면 `window.mediaGrab`에 결과와 재수집 함수가 생깁니다.
필요한 리뷰 목록을 열고 스크롤해 데이터를 로딩한 뒤 실행하세요. **영상의 재생 버튼을 누를 필요는 없습니다.**
초기 자동 수집을 기다리려면 `await mediaGrab.ready`를 실행합니다. 발견한 주소는 팝업을 닫아도 보존합니다.

## Windows PowerShell로 일괄 다운로드하기 (추가 설치 없음)

브라우저 ZIP에서 `Failed to fetch`가 많이 나왔다면 먼저 이 방식을 사용합니다.
PowerShell은 브라우저 밖에서 HTTP 요청을 보내므로 JavaScript의 CORS 제한을 적용받지 않습니다.
서버 자체의 403/404나 로그인 요구까지 해결하는 것은 아닙니다.

1. 이 저장소의 최신 ZIP을 내려받고 **압축을 풉니다**. `download-media-powershell.cmd`와 `download-media.ps1`을 같은 폴더에 둡니다.
2. **이미 브라우저 ZIP의 `download-report.json`이 있다면 그대로 사용합니다.** 새로 수집하려면 상품 상세를 전부 펼친 뒤 수집 코드를 실행하고, Console에서 아래 명령으로 목록을 저장합니다.

   ```js
   mediaGrab.export()
   ```

3. 저장한 **`download-report.json` 또는 `media-manifest.json`을 `download-media-powershell.cmd` 위로 드래그**합니다.
4. 완료될 때까지 창을 열어 둡니다. 결과는 **입력 파일이 있는 폴더** 아래 `download-output/날짜-시간-식별자/`에 저장합니다. 창 마지막에도 저장 경로를 표시합니다.

Windows PowerShell 5.1과 기본 .NET 기능을 사용합니다. Python, 별도 PowerShell 모듈이나 PowerShell 7을 설치할 필요가 없습니다.
실행 파일은 이 실행에 한해 `-ExecutionPolicy Bypass`를 적용하며, 컴퓨터의 실행 정책을 영구 변경하지 않습니다.

기존 보고서를 드래그하면 성공·실패 항목을 모두 다시 시도합니다. 정확히 같은 주소는 첫 항목만 유지합니다.
파일은 `0001.jpg`, `0002.gif`, `0003.mp4`처럼 **입력 목록의 순서를 유지하는 번호**로 저장합니다.
보고서에 유효한 순번이 있으면 그 순번을 유지하고, 실패한 번호에는 파일이 없어 번호가 중간에 비어 있을 수 있습니다.
GIF·동영상은 받은 바이트 그대로 저장합니다. 매번 새 결과 폴더를 만들어 기존 결과를 덮어쓰지 않습니다.

| 결과 파일 | 내용 |
|---|---|
| `download-report.json` | 모든 주소의 처리 결과. 이 파일을 드래그해 다시 시도할 수 있음 |
| `download-report.csv` | 순번·저장 파일명·상태·HTTP 상태·원본 URL·오류 내용 |
| `failed.csv` | 실패하거나 건너뛴 주소와 사유. Excel에서 열 수 있는 UTF-8 BOM 형식 |

`saved`는 미디어 저장, `playlist`는 재생목록만 저장, `link`는 외부 영상 바로가기 저장, `failed`는 다운로드·형식 확인 실패, `skipped`는 지원하지 않는 주소 등입니다.
URL 확장자나 MIME 표기만 믿지 않고 실제 파일 앞부분을 확인하므로 `OK`·HTML·JSON 오류 응답은 미디어로 저장하지 않습니다.
이 검사는 파일 전체의 재생 가능성이나 실제 애니메이션 여부까지 확인하는 기능은 아닙니다.

스니펫 마지막에 `mediaGrab.download();`를 붙여 사용했다면 **그 줄을 아래로 교체**합니다.
이후에는 상세 펼치기·스크롤을 끝내고 스니펫을 실행해 목록을 저장한 다음, 목록 파일을 실행 파일에 드래그합니다.

```js
mediaGrab.export();
```

명령으로 실행하려면 압축을 푼 저장소 폴더에서 PowerShell을 열고 아래처럼 입력합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\download-media.ps1" -Manifest "C:\Users\사용자\Downloads\media-manifest.json"
```

보고서의 실패·건너뜀 항목만 재시도하려면 `-OnlyFailed`를 붙입니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\download-media.ps1" -Manifest "C:\Users\사용자\Downloads\download-report.json" -OnlyFailed
```

- 내보낸 `{items, pageUrl}` JSON, 기존 `{results, pageUrl}` 보고서, JSON 배열, CSV 보고서와 한 줄에 URL 하나인 UTF-8 텍스트 목록을 지원합니다. `failed.csv`를 드래그할 수도 있습니다.
- JSON에 상품 페이지 주소가 있으면 해당 사이트의 출처만 `Referer`로 전달합니다. 상품 페이지 URL의 쿼리는 Referer에 포함하지 않고, 브라우저의 로그인 쿠키도 가져오지 않습니다. 미디어 URL 자체의 쿼리는 유지합니다. CSV·텍스트에는 상품 페이지 주소가 없으므로 출처 정보도 전달되지 않습니다.
- 한 번에 하나씩 받습니다. `-TimeoutSec 120`으로 파일 한 개의 전체 요청 제한을 조절할 수 있으며 기본은 60초입니다.
- 기본 파일 한 개의 크기 제한은 256 MiB입니다. `-MaxFileMB 512`처럼 조절할 수 있으며 허용 범위는 1~1024 MiB입니다.
- `-OutputPath "새 폴더 경로"`로 저장 위치를 지정할 수 있습니다. 이미 존재하는 폴더에는 저장하지 않습니다.
- 지원하는 형식의 `data:` 주소도 저장합니다. 브라우저 세션에 의존하는 `blob:` 주소는 건너뜁니다.
- `.m3u8`·`.mpd`는 재생목록만 저장합니다. 영상 조각 병합·DRM 처리는 지원하지 않습니다.
- 서버 접속 제한과 만료된 주소는 실패 기록에 남기고 다음 파일로 진행합니다. 일부 주소가 실패해도 나머지 다운로드는 계속합니다.

## 유튜브 임베드와 재생 없이 수집하는 리뷰 영상

유튜브 iframe의 내부 문서를 읽을 수 없어도 부모 페이지의 `src`, `data-src` 등을 읽어 영상 ID와 시청 주소를 수집합니다.
`type: "EMBED"`, `provider: "youtube"`, `videoId`, `embedUrl`을 기록하며 같은 영상 ID는 한 번만 수집합니다.
재생 버튼의 `<cued-overlay>` HTML만으로는 영상 ID를 알 수 없으므로 iframe 주소가 필요합니다.

쿠팡 리뷰의 `origin_thumbnail.0000002.jpg`는 **미리보기 이미지**입니다.
이 이미지를 MP4로 이름만 바꾸거나 경로에서 영상 URL을 추측하지 않습니다.
대신 썸네일만 확인된 리뷰를 `pendingVideos`로 알리고, 원본 주소가 확인되면 목록에서 제거합니다.

1. 상품 상세와 필요한 리뷰 목록을 펼친 뒤 최신 `collect-page-media.js` 전체를 콘솔에서 실행합니다.
2. `await mediaGrab.ready`로 초기 자동 수집을 기다립니다. 데이터에 원본 주소가 있으면 영상 리뷰를 재생하지 않아도 수집합니다.
3. 실행 후 리뷰 목록을 더 열거나 스크롤했다면 아래 명령으로 다시 확인하고 목록을 내보냅니다.

   ```js
   await mediaGrab.collectReviewVideos()
   console.table(mediaGrab.videos)        // 원본 영상, 재생목록, 유튜브 시청 주소
   console.table(mediaGrab.pendingVideos) // 썸네일만 확인된 리뷰
   mediaGrab.export()
   ```

수집기는 JSON 스크립트·페이지 초기 데이터·썸네일 주변의 데이터 속성과 읽을 수 있는 React props/state를 확인합니다.
React 내부 필드는 공개 API가 아니므로 없거나 구조가 바뀌면 건너뜁니다. 페이지의 getter, 이벤트 핸들러나 재생 함수를 호출하지 않습니다.
실행 이후 페이지가 받는 같은 출처의 리뷰 `fetch`·XHR 응답도 읽습니다. `fetch` 본문은 복제해서 읽고 페이지에 원래 Promise와 Response를 돌려줍니다.

원본 미확인 리뷰가 있으면 **이미 관찰한 리뷰 목록 GET 주소**를 그대로 재조회합니다. 새로운 API 경로를 추측하거나 리뷰를 자동 클릭하지 않습니다.
과거 Resource Timing에는 요청 메서드가 없으므로 쿠팡의 `/vp/product/reviews` 목록 경로만 GET 재조회 후보로 사용하며,
그 외 목록 경로는 코드 실행 후 실제 GET 요청을 관찰한 경우에만 재조회합니다. POST 요청은 반복하지 않습니다.
재조회에는 같은 출처의 브라우저 세션을 사용하고 새 헤더·요청 본문을 만들지 않습니다. 별도 인증 헤더가 필요한 응답은 실패할 수 있습니다.
이미 로딩된 리뷰만 다루며, 전체 리뷰 페이지를 자동으로 순회하지는 않습니다.

**서버가 썸네일만 제공하고 원본 주소는 재생할 때만 보낸다면 재생 없이 수집할 수 없습니다.**
그 경우 `pendingVideos`에 남습니다. `mediaGrab.reviewCollection`에서 응답 대기·재조회 오류·크기 제한을 확인할 수 있습니다.
리뷰 응답과 스크립트는 2 MiB까지 읽고, 데이터 탐색은 깊이 20·값 20,000개로 제한합니다.
한 번에 최대 8개 목록을 재조회하며 요청당 8초, 응답 대기 8초를 적용합니다. 제한에 걸린 데이터를 모두 읽었다고 표시하지 않습니다.
실제 쿠팡 상품 페이지의 최신 응답 구조는 접근 가능한 브라우저에서 별도로 확인해야 합니다.

`export()`와 `download()`는 처리 전에 현재 페이지를 다시 수집합니다.
`visibleOnly: true`는 닫힌 팝업의 영상 주소를 제외할 수 있으므로 리뷰 영상 수집에는 기본 옵션을 사용하세요.

| 명령 | 동작 |
|---|---|
| `await mediaGrab.ready` | 초기 페이지 데이터 검사와 자동 목록 재조회 결과 대기 |
| `await mediaGrab.collectReviewVideos()` | 현재 데이터 재검사, 필요한 관찰된 GET 목록 재조회, 진행 중인 응답 대기 |
| `await mediaGrab.collectReviewVideos({refresh:false})` | 추가 요청 없이 현재 데이터와 진행 중인 리뷰 응답만 확인 |
| `mediaGrab.embeds` | 유튜브 임베드에서 확인한 시청 주소 |
| `mediaGrab.videos` | 임시 blob을 제외한 `VIDEO`, `STREAM`, `EMBED` |
| `mediaGrab.pendingVideos` | 원본 주소를 확인하지 못한 쿠팡 리뷰 썸네일 |
| `mediaGrab.reviewCollection` | 진행 중인 리뷰 응답·목록 재조회 오류·탐색 제한 |
| `mediaGrab.watching` | 자동 영상 감시 상태 |
| `mediaGrab.stopWatching()` | 이벤트·DOM·네트워크 관찰과 폴링 종료, 수집기가 설치한 fetch·XHR 관찰 해제 |
| `mediaGrab.watch()` | 감시와 초기 자동 수집 재시작 |

유튜브 시청 주소는 영상 파일이 아닙니다. 브라우저 ZIP과 기존 Python·PowerShell 도구는
번호가 붙은 `.url` 바로가기와 `link` 상태를 남깁니다. 영상 파일 저장에는 아래 도구를 사용합니다.

## 설치 없이 콘솔에서 m3u8 리뷰 영상을 MP4로 저장하기

완료된 HLS 영상의 재생목록과 TS 조각을 브라우저에서 읽고, 포함된 mux.js 코드로 MP4에 담아 ZIP으로 저장합니다.
영상·음성을 재인코딩하거나 재생하지 않습니다. `ffmpeg.exe`, `ffprobe.exe`, Python은 필요하지 않습니다.
병합 코드는 `collect-page-media.js` 안에 포함돼 있으므로 외부 라이브러리·Worker·WASM을 실행 시 다운로드하지 않습니다.
버전·출처·라이선스는 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)에 기록합니다.

1. 필요한 리뷰 목록을 로딩하고 최신 `collect-page-media.js` 전체를 상품 페이지 콘솔에 붙여 넣습니다.
2. 초기 수집을 기다린 뒤 HLS 영상을 저장합니다.

   ```js
   await mediaGrab.ready
   await mediaGrab.downloadHls()
   ```

3. 저장된 `page-media-날짜-시간-001.zip`을 풉니다. 전체 수집 목록의 순번을 유지한 `0121.mp4` 같은 파일과 다운로드 보고서가 들어 있습니다.
4. 이미지·GIF는 기존처럼 `mediaGrab.export()`로 목록을 내보내 `download-media-powershell.cmd`에 드래그해서 받으면 됩니다. HLS 영상에 `download-videos.cmd`를 추가로 실행할 필요는 없습니다.

지원 범위는 **하나의 목록에 영상·음성이 함께 있는 H.264·AAC TS 방식의 VOD**입니다. 무음 영상도 지원합니다.
중첩된 마스터 목록에서는 지원하는 코덱·트랙 중 높은 대역폭의 변형을 선택하고, 상대 조각 주소는 원본 서버 주소를 기준으로 읽습니다.
암호화, 라이브, 별도 음성 목록, fMP4 조각, 바이트 범위, 중간 코덱·트랙 변경, DASH·유튜브는 이 기능의 대상이 아닙니다.
지원하지 않거나 조각 요청이 실패하면 `failed`로 기록하고 다음 영상으로 진행합니다. 일부 조각만 만든 MP4는 ZIP에 넣지 않습니다.

**원본 목록과 모든 TS 조각을 서버가 브라우저에 읽도록 허용해야 합니다(CORS).**
페이지에서 재생된다는 사실만으로 콘솔 `fetch()`도 읽을 수 있는 것은 아닙니다.
서버가 허용하지 않거나 CSP·접속 제한으로 막히면 `failed.csv`에 기록합니다. 콘솔 코드로 브라우저 보안 제한을 해제하지 않습니다.
TS 패킷·MP4 트랙 구조를 확인하지만 브라우저에서 파일 전체를 디코딩하는 검사는 수행하지 않습니다.
일반 MP4 파일과 달리 출력은 fragmented MP4이므로 플레이어에 따라 탐색 기능이 다를 수 있습니다.

기본 한 영상의 TS 입력·MP4 출력 크기 제한은 각각 256 MiB, 요청 제한은 30초입니다.
HLS 목록은 최대 2 MiB, 중첩은 5개, 한 영상의 TS 조각은 1,000개까지입니다.
`await mediaGrab.downloadHls({maxFileMB:512, timeoutMs:60000})`로 파일·요청 제한을 조절할 수 있습니다.
중단은 `mediaGrab.stopDownload()`, 저장 재요청은 `mediaGrab.saveArchive(1)`을 사용합니다.
진행 결과는 `mediaGrab.lastDownload`에서 확인합니다. 여기의 `packed`는 ZIP에 MP4 바이트를 넣었다는 뜻입니다.

이미지와 지원하는 HLS까지 한 ZIP으로 받고 싶으면 아래처럼 실행합니다. 이미지에도 브라우저 CORS 제한이 적용됩니다.

```js
await mediaGrab.download({hls:"mp4"})
```

기존 `await mediaGrab.download()`의 기본 동작은 재생목록 저장을 유지합니다.
콘솔에서 읽을 수 없는 원본이나 위 지원 범위 밖의 스트림은 아래 FFmpeg 방식으로 받을 수 있습니다.

## 선택: FFmpeg로 m3u8·mpd를 MP4로 저장하기

`download-videos.py`는 수집 목록과 다운로드 보고서에서 영상 주소만 선택합니다.
이미지와 미확인 리뷰 썸네일은 영상 주소로 취급하지 않습니다.

`download-media-powershell.cmd` 등 기본 파일 다운로드 도구의 `playlist` 상태는 **재생목록 파일 저장**입니다.
작은 `.m3u8` 파일에는 하위 목록이나 영상 조각 주소가 있으며 영상 바이트는 들어 있지 않습니다.
로컬 파일로 열면 브라우저의 `file:` 보안 제한 또는 상대 주소의 기준 경로 변경으로 재생에 실패할 수 있습니다.
영상 도구는 보고서에 기록된 원본 HTTP·HTTPS 주소에서 하위 목록과 조각을 받아 하나의 MP4로 합칩니다.

1. Python 3.10 이상과 FFmpeg를 준비합니다. [FFmpeg 공식 다운로드 페이지](https://ffmpeg.org/download.html)의 Windows 빌드에서 **`ffmpeg.exe`와 `ffprobe.exe`**를 꺼냅니다.
2. 최신 `download-videos.py`, `download-videos.cmd`와 위 두 실행 파일을 같은 폴더에 둡니다. FFmpeg가 이미 PATH에 있으면 실행 파일을 복사하지 않아도 됩니다.
3. **기존 `download-report.json`을 `download-videos.cmd` 위로 드래그**합니다. `download-report.csv`와 `media-manifest.json`도 지원합니다. 이미 원본 URL을 수집했다면 리뷰를 다시 재생하거나 목록을 다시 내보낼 필요가 없습니다.

명령 프롬프트에서 실행하려면 다음 명령을 사용합니다.

```bat
py -3 download-videos.py download-report.json
```

FFmpeg를 다른 폴더에 두었다면 경로를 지정할 수 있습니다.

```bat
py -3 download-videos.py download-report.json --ffmpeg-location "C:\tools\ffmpeg\bin"
```

결과는 목록 파일 옆의 `video-output/날짜-시간-식별자/`에 저장합니다.
보고서의 순번을 유지하므로 `0121.m3u8`, `0156.m3u8`의 원본은 **`0121.mp4`, `0156.mp4`**로 저장합니다.
FFprobe에서 MP4의 영상 스트림과 재생 시간을 확인한 뒤 `saved`로 기록합니다.
`video-report.json`에는 크기·재생 시간·해상도·음성 포함 여부·처리 결과 및 미확인 리뷰 개수가 들어 있습니다.
미확인 리뷰가 남아 있거나 다운로드가 실패하면 종료 코드는 `2`입니다.

- `STREAM`만 들어 있는 보고서는 **yt-dlp 설치가 필요 없습니다.** Python과 FFmpeg·FFprobe를 사용합니다.
- 첫 번째 영상 스트림과, 있으면 첫 번째 음성 스트림을 선택합니다. `-c copy`로 원본 코덱을 유지하며 재인코딩하지 않습니다. 소리가 없는 리뷰 영상도 저장합니다.
- MP4에 담을 수 없는 코덱, 서버의 403/404, 만료된 주소와 암호화로 읽을 수 없는 스트림은 실패 기록을 남깁니다. DRM 해제 기능은 없습니다.
- CSV에는 상품 페이지 URL이 없으므로 Referer가 필요한 서버에서는 JSON 보고서를 사용하는 편이 좋습니다. JSON에서는 상품 URL의 출처만 Referer로 전달하고 쿼리는 포함하지 않습니다.
- HLS 하위 목록의 상대 주소는 원본 서버 URL을 기준으로 읽습니다. 로컬 `.m3u8` 파일의 이름이나 확장자만 바꾸지 않습니다.
- 영상 하나의 전체 시간 제한은 기본 600초이며 `--timeout 1200`처럼 변경할 수 있습니다. 조각 누락·처리 오류가 있으면 불완전한 영상을 성공으로 기록하지 않습니다. 실패한 임시 MP4는 제거하고 다음 영상으로 진행합니다. 기존 결과 파일은 덮어쓰지 않습니다.

## 선택: 유튜브·직접 영상 주소 다운로드

`EMBED`, `VIDEO` 항목은 **yt-dlp**로 다운로드합니다. 다음 명령으로 준비한 뒤 같은 영상 도구를 사용합니다.

```bat
py -3 -m pip install -U "yt-dlp[default]"
```

음성과 영상이 들어 있는 단일 형식을 우선하고, 없으면 영상 전용 형식을 선택합니다(`b[ext=mp4]/b/bv[ext=mp4]/bv`).
항상 최고 해상도나 MP4를 보장하지 않으며, 제공되는 형식에 따라 확장자가 달라질 수 있습니다.
YouTube 지원은 최신 yt-dlp와 지원되는 JavaScript 실행기(예: Deno 또는 Node.js)에 의존합니다.
설치된 Node.js가 있으면 `--js-runtimes node`를 전달합니다.
고화질 분리 트랙 병합에는 FFmpeg가 필요할 수 있습니다. [yt-dlp 공식 설치·의존성 안내](https://github.com/yt-dlp/yt-dlp#installation)를 참고하세요.
브라우저 쿠키를 읽거나 로그인 제한을 통과하는 기능은 없으며, 서명 주소가 만료되면 최신 리뷰 데이터를 수집해 목록을 다시 내보내세요.

## 리뷰 영상이 blob 주소로만 잡힐 때

`video.currentSrc`가 `blob:https://...`이면 브라우저 내부 객체를 가리키는 임시 주소입니다.
이 주소는 완성된 영상 파일을 담은 Blob 또는 조각을 재생하는 MediaSource에 연결될 수 있습니다. 주소만으로 둘을 구분할 수 없습니다.
PowerShell 도구는 이 주소를 건너뛰며, 브라우저 ZIP 기능도 MediaSource 자체를 영상 파일로 받지는 못합니다.

Video.js 재생기는 DOM 영상 주소와 별도로 원본 소스를 보관할 수 있습니다.
수집기는 재생 요소의 `.player` 참조 또는 `videojs.getPlayer()`로 이미 있는 재생기를 찾아 `currentSource()`·`currentSources()`·`currentSrc()`를 읽습니다.
소스 주소에 확장자가 없더라도 HLS·DASH MIME이면 `STREAM`으로 표시합니다. [Video.js Player API](https://docs.videojs.com/player)
재생기를 새로 만들거나 재생·소스 변경 명령을 실행하지 않습니다.

1. 최신 `collect-page-media.js`의 **전체 코드로 스니펫을 교체**합니다.
2. 먼저 `await mediaGrab.collectReviewVideos()`로 원본 주소를 확인합니다. 페이지 데이터에 주소가 없다면, 직접 재생하기로 선택한 영상의 열린 재생창에서 `mediaGrab.scan()`으로 재생기 소스를 확인할 수도 있습니다.
3. 아래 명령으로 브라우저 밖에서도 사용할 수 있는 영상·재생목록 주소를 확인하고, 전체 URL을 클립보드에 복사합니다.

   ```js
   (() => {
     mediaGrab.scan();
     const rows = mediaGrab.rows.filter(r =>
       ["VIDEO", "STREAM"].includes(r.type) && !r.temporary);
     console.table(rows);
     copy(JSON.stringify(rows, null, 2));
   })();
   ```

4. 원본 주소가 잡혔다면 `mediaGrab.export()`로 새 목록을 저장해 PowerShell 도구에 전달할 수 있습니다. **MP4 등 직접 파일은 영상으로, HLS·DASH는 재생목록 파일까지만 저장**합니다. 조각 병합 기능은 아직 없습니다.

`source`가 `videojs.currentSource` 등으로 표시되면 재생기에서 읽은 주소입니다. 다른 경로에서 같은 URL을 먼저 수집했다면 그 경로가 표시될 수도 있습니다.
재생기의 API를 페이지에서 접근할 수 없거나 원본 주소 대신 blob만 보관하면 이 경로로 원본 URL을 찾을 수 없습니다.
원본 주소가 수집됐다는 사실도 서버에서의 다운로드 성공을 보장하지는 않습니다.
그대로 복사한 재생창 HTML에는 런타임 재생기 객체가 들어 있지 않으므로, 원본 URL이 HTML에 없을 때는 실제 페이지에서 코드를 실행해야 합니다.

## 설치 없이 콘솔·스니펫에서 ZIP 다운로드하기

최신 `collect-page-media.js`로 수집한 뒤, 상품 페이지의 Console에서 실행합니다.

```js
await mediaGrab.download()
```

브라우저가 읽을 수 있는 파일을 받은 뒤 `page-media-날짜-시간-001.zip` 저장을 요청합니다.
ZIP을 풀면 `0001.jpg`, `0002.gif`, `0003.mp4`처럼 **페이지 순서의 번호가 붙은 원본 파일**이 나옵니다.
GIF와 영상의 받은 바이트를 그대로 보존합니다. 순번은 전체 수집 목록을 기준으로 하며, 실패·필터로 제외된 번호에는 파일이 없습니다.
실제 파일 앞부분의 형식 표식을 확인하므로, `.gif` 주소의 `OK`나 HTML·JSON 오류 본문을 미디어 파일로 저장하지 않습니다.

DevTools의 **Sources → Snippets**에 코드를 저장해 사용한다면, 수집 코드 마지막 줄 다음에 아래 한 줄을 추가합니다.
이후 스니펫 실행 한 번으로 수집과 다운로드를 시작할 수 있습니다. 상품 상세 펼치기·스크롤은 실행 전에 완료합니다.

```js
mediaGrab.download();
```

각 ZIP에는 해당 ZIP에 대응하는 `download-report.json`, `download-report.csv`, `failed.csv`도 들어 있습니다.
`packed`는 원본 파일을 읽어 ZIP에 넣었다는 의미이며, 브라우저가 사용자 디스크에 저장한 사실까지 확인하는 값은 아닙니다.
`playlist`는 재생목록만 포함, `link`는 외부 영상의 `.url` 바로가기만 포함,
`failed`는 읽기·형식 확인 실패, `skipped`는 중단으로 처리하지 않은 주소입니다.
전체 결과는 `mediaGrab.lastDownload`에서 확인합니다.

| 명령 | 동작 |
|---|---|
| `await mediaGrab.download({ visibleOnly: true })` | 표시되는 요소의 선택 주소만 받기. 현재 viewport 안으로 제한하는 옵션은 아님 |
| `await mediaGrab.download({ start: 1, end: 100 })` | 전체 수집 목록의 지정 순번만 받기 |
| `mediaGrab.stopDownload()` | 현재 요청을 중단하고 남은 주소를 건너뛴 보고서와 ZIP 만들기 |
| `mediaGrab.lastDownload.results` | 모든 주소의 처리 결과 보기 |
| `mediaGrab.lastDownload.archives` | 생성한 ZIP의 목록·크기·임시 링크 보기 |
| `mediaGrab.saveArchive(1)` | 생성한 첫 번째 ZIP의 저장을 다시 요청하기. 두 번째는 `2` |
| `mediaGrab.clearDownloads()` | 다운로드가 끝난 뒤 ZIP 임시 URL과 결과 참조 해제 |

### 우클릭 저장과 다른 점

우클릭의 **이미지를 다른 이름으로 저장**은 브라우저 자체의 저장 기능입니다.
콘솔 스크립트가 원본을 읽어 ZIP에 넣으려면 해당 응답을 JavaScript에서 읽을 수 있어야 합니다.
이미지가 화면에 보이더라도, 다른 출처의 이미지 서버가 CORS를 허용하지 않으면 원본 읽기는 실패할 수 있습니다.
[`fetch`의 CORS·credentials 설명](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch)을 참고하세요.
`mode: 'no-cors'`로 바꾸면 읽을 수 없는 opaque 응답이 되므로 원본을 저장하는 해결책이 아닙니다.
이미지 URL에 `download` 속성만 붙이는 방식도 다른 출처에서는 일괄 저장을 보장하지 않습니다. [링크의 download 제한](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/a#download)

- CORS·CSP·혼합 콘텐츠 제한, 403/404, 만료된 주소는 보고서에 기록하고 다음 파일로 진행합니다. 네트워크 오류만으로 구체적인 차단 원인을 확정하지 않습니다.
- 기본 `credentials: 'same-origin'`으로 같은 출처의 세션은 사용하며, 다른 출처에는 쿠키를 보내지 않습니다. `{ credentials: 'include' }`를 지정할 수 있으나, 서버의 CORS 자격 증명 허용과 브라우저 쿠키 정책이 충족되어야 합니다.
- 접근 가능한 `data:`와 실제 파일을 담은 `blob:`은 지원합니다. MediaSource에 연결된 `blob:` 영상은 완성된 파일이 아니므로 이 방식으로 저장을 보장할 수 없습니다.
- `.m3u8`·`.mpd`는 재생목록만 저장합니다. 영상 조각 병합·DRM 처리는 지원하지 않습니다.
- 기본 파일 한 개의 제한은 256 MiB입니다. ZIP의 미디어 합계가 약 256 MiB를 넘으면 별도의 독립 ZIP으로 나눕니다. 한 파일은 나누지 않으므로 ZIP 자체의 크기는 이 기준을 넘을 수 있습니다. 메타데이터 크기도 추가됩니다.
- `{ maxFileMB: 512, maxZipMB: 256 }`처럼 크기 제한을 조절할 수 있으며 두 옵션은 0 초과~1024 MiB까지입니다. ZIP 데이터는 브라우저에서 보관하므로 용량이 크면 순번 범위를 나누어 받습니다.
- 여러 ZIP의 자동 저장을 브라우저가 막으면 해당 사이트의 여러 파일 다운로드를 허용하거나 `saveArchive(번호)`로 각각 저장합니다. 이 API는 저장 요청만 하며, 브라우저의 저장 설정을 변경하지 않습니다.
- 원본은 한 번에 하나씩 받습니다. `{ timeoutMs: 60000 }`으로 파일 한 개의 요청 제한을 60초로 조절할 수 있습니다. 기본은 30초이며 파일 읽기 전체에 적용합니다.
- 다음 `download()` 실행은 이전 ZIP 임시 URL을 해제합니다. 저장이 끝나면 `clearDownloads()`를 실행하거나 페이지를 닫아 참조를 정리할 수 있습니다.

## 선택: Python으로 윈도우에서 일괄 다운로드하기

1. **Python 3.10 이상**을 설치합니다. [공식 Windows 다운로드](https://www.python.org/downloads/windows/)에서 설치할 수 있으며, 별도 Python 패키지는 필요하지 않습니다.
2. 이 저장소의 최신 ZIP을 받아 압축을 풉니다. `download-media.cmd`와 `download-media.py`를 같은 폴더에 둡니다.
3. 위의 실행 순서대로 상품 상세를 펼치고, 최신 `collect-page-media.js`를 상품 페이지의 Console에서 실행합니다.
4. Console에서 아래 명령을 실행해 `media-manifest.json`을 저장합니다.

   ```js
   mediaGrab.export()
   ```

5. 저장한 **`media-manifest.json`을 `download-media.cmd` 위로 드래그**합니다. 압축 파일 안에서 실행하지 말고, 압축을 푼 폴더에서 실행하세요.
6. 완료될 때까지 창을 열어 둡니다. 결과는 **목록 파일이 있는 폴더** 아래 `download-output/날짜-시간-식별자/`에 저장합니다. 예를 들어 목록을 다운로드 폴더에 저장했다면 그 폴더 아래에 결과가 생깁니다.

파일명은 `0001.jpg`, `0002.gif`, `0003.mp4`처럼 목록의 순번을 따릅니다. 여러 파일을 동시에 받아도 파일명의 순번은 바뀌지 않습니다.
실패한 순번에는 미디어 파일이 없으므로 번호가 중간에 비어 있을 수 있습니다. 매번 새로운 결과 폴더를 만듭니다.
GIF·영상은 받은 원본 바이트 그대로 저장하며, 이미지 한 장으로 변환하거나 재인코딩하지 않습니다.

`export()`는 수집한 전체 후보 주소를 내보냅니다. 표시되는 요소의 선택 주소만 받으려면 아래 명령을 사용합니다.
이는 현재 화면 안으로 제한하는 옵션이 아니며, 선택되지 않은 해상도 후보·숨긴 요소·네트워크 기록에만 있는 주소 등을 제외합니다.

```js
mediaGrab.export({ visibleOnly: true })
```

더보기·갤러리·팝업을 추가로 조작한 뒤에는 `mediaGrab.scan()`으로 재수집하고 다시 내보냅니다.
목록 파일에는 콘솔 표에 생략되어 보이는 긴 주소도 전체 문자열로 저장합니다.
브라우저에서 파일 저장이 시작되지 않으면 Console에서 아래 명령으로 복사한 뒤, 텍스트 편집기로 **UTF-8 형식의 `media-manifest.json`**을 저장합니다.

```js
copy(JSON.stringify(mediaGrab.getManifest(), null, 2))
```

명령줄에서 실행할 수도 있습니다. 터미널을 저장소 폴더에서 열고 목록 파일의 경로를 전달합니다.

```bat
py -3 download-media.py "C:\Users\사용자\Downloads\media-manifest.json"
```

`py` 대신 Python 실행 파일을 직접 쓰려면 `python download-media.py "목록 파일 경로"`로 실행합니다.
입력은 내보낸 JSON 외에도 `mediaGrab.rows`를 복사한 JSON 배열, URL 문자열의 JSON 배열, 한 줄에 URL 하나인 UTF-8 텍스트 파일을 지원합니다.
정확히 같은 URL은 첫 항목만 유지하고, 입력 순서대로 번호를 매깁니다. URL 목록만 전달하면 상품 페이지의 출처 정보는 전달되지 않습니다.

### 다운로드 결과와 제한

| 결과 파일 | 내용 |
|---|---|
| `download-report.csv` | 모든 주소의 순번·저장 파일명·상태·HTTP 상태·원본 URL·오류 내용 |
| `download-report.json` | 같은 결과의 JSON 기록 |
| `failed.csv` | 실패했거나 건너뛴 주소와 사유. Excel에서 열 수 있는 UTF-8 BOM 형식 |

상태는 `saved`(미디어 저장), `playlist`(재생목록만 저장), `link`(외부 영상 바로가기 저장), `failed`(다운로드·형식 확인 실패), `skipped`(지원하지 않는 주소 등)입니다.
일부 주소가 실패해도 나머지 다운로드는 계속됩니다. 종료 코드는 모두 처리하면 0, 실패·건너뜀이 있으면 2, 시작하지 못하면 1입니다.

다운로드 도구는 URL 확장자나 `Content-Type`만 믿지 않고 받은 파일 앞부분의 형식 표식을 확인합니다.
JPEG·PNG·GIF·WebP·AVIF·HEIC/HEIF·SVG·TIFF·BMP·ICO와 MP4/MOV·WebM/MKV·AVI·Ogg·MPEG의 흔한 표식을 지원합니다.
`OK`, HTML, JSON 오류 응답은 미디어 파일로 저장하지 않습니다. 형식 표식 검사이므로 파일 전체의 디코딩·재생 가능성이나 실제 애니메이션 여부를 검증하는 기능은 아닙니다.

- JSON에 상품 페이지 주소가 있으면 해당 사이트의 출처를 `Referer`로 전달합니다. 브라우저의 쿠키·로그인 세션은 가져오지 않으므로, 출처만으로 접근 조건이 충족되지 않으면 403 등이 기록됩니다.
- 403/404, 만료된 링크와 서버 접속 제한은 이 도구로 보장해서 해결할 수 없습니다. 실패 사유를 `failed.csv`에서 확인합니다.
- `data:image/...`·`data:video/...` 주소는 지원하는 형식이면 저장합니다. `blob:` 주소는 원래 브라우저 세션에 의존하므로 건너뜁니다.
- `.m3u8`·`.mpd`는 **재생목록 파일만 저장**합니다. 영상 조각을 받아 하나의 MP4로 합치거나 DRM을 처리하는 기능은 없습니다.
- 동시에 4개를 다운로드합니다. 필요하면 `--workers 1` 등으로 조절하며, 범위는 1~16입니다. `--timeout 20`은 연결·읽기 대기 제한을 초 단위로 지정합니다.
- `--output "새 폴더 경로"`로 저장 위치를 지정할 수 있습니다. 이미 존재하는 폴더에는 저장하지 않습니다.

## 결과 확인과 복사

```js
// 화면 위치 순서로 정렬한 미디어 후보 주소 배열
mediaGrab.urls

// 순번, 유형, 주소, 발견 경로, 페이지 좌표, 표시 여부, 임시 주소 여부
mediaGrab.rows

// 표시되는 요소의 선택 주소만 같은 순서로 확인
mediaGrab.visibleUrls
mediaGrab.visibleRows

// 미디어에서 제외한 통계·이벤트 주소와 제외 사유
mediaGrab.excludedRows
mediaGrab.excludedUrls

// 자동 접근하지 못한 iframe
mediaGrab.blockedFrames

// 더보기·스크롤·갤러리·팝업 조작 후 추가 수집
mediaGrab.scan()

// 일괄 다운로드용 목록을 파일로 저장
mediaGrab.export()

// 파일 저장 없이 목록 객체 확인
mediaGrab.getManifest()

// 브라우저에서 원본을 읽어 ZIP 다운로드
await mediaGrab.download()
```

Chrome/Edge 개발자도구 Console의 `copy()`로 주소를 클립보드에 복사할 수 있습니다.

```js
// 표시되는 이미지·영상 주소를 화면 위치 순서로 복사 (권장)
copy(mediaGrab.visibleUrls.join('\n'))

// 수집한 미디어 후보 주소를 한 줄에 하나씩 복사
copy(mediaGrab.urls.join('\n'))

// 유형과 페이지 좌표를 포함한 JSON 복사
copy(JSON.stringify(mediaGrab.rows, null, 2))

// GIF로 분류된 주소만 복사
copy(mediaGrab.rows.filter(x => x.type === 'GIF').map(x => x.url).join('\n'))

// 동영상과 스트리밍 목록 주소 복사
copy(mediaGrab.rows.filter(x => ['VIDEO', 'STREAM'].includes(x.type)).map(x => x.url).join('\n'))
```

`scan()`은 기존 미디어·제외 주소 기록을 유지하면서 새 주소를 추가하고, 현재 요소의 위치와 표시 상태를 다시 계산합니다.
사라진 요소나 이전에만 로딩한 주소는 위치 미확인 그룹으로 이동합니다. 수집 기록을 초기화하려면 파일의 전체 코드를 다시 실행합니다.
페이지 전체를 대상으로 하므로 상품 상세뿐 아니라 추천상품, 후기, 아이콘, 광고와 이전에 로딩한 미디어 주소도 포함될 수 있습니다.

## 정렬 기준

- 요소의 페이지 좌표 `top`을 먼저 비교하고, 같으면 `left`를 비교합니다. 현재 브라우저 화면 아래의 일반 문서 요소도 포함하며, 페이지를 스크롤해도 일반 요소의 페이지 좌표는 유지됩니다.
- `mediaGrab.urls`는 수집한 미디어 후보 주소를 유지합니다. 같은 요소의 `src`, `srcset`, 지연 로딩 속성에 서로 다른 주소가 있으면 해당 요소의 위치에 함께 놓습니다. 같은 위치에서는 선택된 주소를 먼저 둡니다.
- `mediaGrab.visibleUrls`는 표시되는 요소의 `currentSrc` 등 선택된 주소와 계산된 CSS 이미지 주소를 골라 냅니다. 숨겨진 요소, 완전히 잘린 갤러리 항목, 선택되지 않은 해상도 후보, 네트워크 기록에만 있는 주소는 제외합니다. 현재 viewport 안의 요소만으로 제한하는 옵션은 아닙니다.
- 정확히 같은 URL이 여러 곳에 있으면 한 번만 수집하고, 현재 표시되는 첫 위치를 기준으로 정렬합니다. 화면에 등장하는 횟수를 그대로 재현하는 목록은 아닙니다.
- 위치를 연결할 수 없는 주소는 전체 목록의 뒤에 놓습니다. 이 그룹 안에서는 최초 발견 순서를 유지합니다.
- 더보기를 펼치거나 레이아웃이 바뀐 뒤에는 `mediaGrab.scan()`으로 다시 정렬합니다.

좌표는 요소의 사각형을 기준으로 계산합니다. CSS 배경·가상 요소는 해당 요소의 위치를 사용하며, 접근 가능한 iframe은 부모 페이지 좌표로 환산합니다.
실제 픽셀을 검사하는 기능은 아니므로 다른 요소에 가려진 이미지, 복잡한 회전·변형, 고정·sticky 요소, 영상 재생 중의 포스터 표시 상태까지 정확히 판단하지는 않습니다.

## 수집 대상

- `img`의 `currentSrc`, `src`, `srcset`과 여러 지연 로딩 속성
- `picture > source`, SVG의 외부 `image` 주소, 이미지형 `input`, 이미지·영상형 `object`/`embed`
- CSS 배경·마스크·테두리·목록 이미지와 `::before`/`::after`의 이미지 주소
- `video`/`source`의 영상 주소와 `video.poster`, 접근 가능한 Video.js 재생기의 원본 소스
- 쿠팡 리뷰의 JSON·초기 데이터·주변 React 데이터와 같은 출처의 리뷰 목록 응답에 있는 원본 영상 주소
- 미디어 파일을 직접 가리키는 링크 및 일부 `data-*` 이미지·영상 속성
- 접근 가능한 iframe과 열린 Shadow DOM
- Resource Timing에 기록된 미디어 주소

CSS의 `url(#id)`와 현재 문서 URL에 `#id`가 붙은 주소는 페이지 안의 SVG 참조이므로 별도 이미지 파일 목록에서 제외합니다.
외부 SVG 파일의 `mask.svg#id`, 실제 `data:image/...` 주소는 계속 수집합니다. 이 수정 이후 전체 개수가 줄어드는 것은 내부 참조를 제거한 결과일 수 있습니다.
`mercury.coupang.com/e.gif`는 GIF로 오인되는 통계·이벤트 요청 주소로 제외하고, `excludedRows`에서 주소와 사유를 확인할 수 있습니다.
필터는 이 호스트와 경로가 정확히 일치하는 경우만 적용합니다. 다른 GIF 주소, CSS의 로딩 애니메이션, fetch/XHR로 받은 일반 미디어 후보 주소는 유지합니다.

| `type` | 의미 |
|---|---|
| `IMAGE` | 이미지로 판단한 주소 |
| `GIF` | `.gif` 확장자 또는 명시적인 GIF MIME 표기로 판단한 주소 |
| `VIDEO` | 영상 요소나 영상 확장자로 판단한 주소 |
| `STREAM` | `.m3u8` / `.mpd` 스트리밍 목록 주소 |
| `EMBED` | 외부 영상 플레이어의 시청 주소. 직접 영상 파일은 아님 |

| 추가 필드 | 의미 |
|---|---|
| `order` | 정렬한 전체 목록의 1부터 시작하는 순번 |
| `top`, `left` | 페이지 좌상단을 기준으로 한 좌표(px). 위치를 알 수 없으면 `null` |
| `visible` | 표시되는 요소의 선택 주소 또는 계산된 CSS 이미지 주소인지 여부 |
| `source` | 주소를 발견한 요소 속성이나 CSS, 네트워크 등의 경로 |
| `temporary` | `true`이면 페이지 세션에 의존하는 `blob:` 임시 주소 |
| `provider`, `videoId`, `embedUrl` | 외부 영상의 제공자·영상 ID·발견한 임베드 주소. `EMBED`에만 포함 |

내보낸 JSON의 `pendingVideos`는 썸네일만 확인된 리뷰이며, `blockedFrames`는 내부 문서 접근이 제한된 iframe입니다.

## 수집·다운로드 기능 검증

아래 명령은 Node.js가 설치된 개발 환경에서 실행합니다. 브라우저에서 스크립트를 사용할 때는 Node.js가 필요하지 않습니다.

```sh
node --check collect-page-media.js
node --test tests/media-order.test.cjs
```

수집·ZIP 자동 테스트로 로딩·DOM 순서와 다른 좌표 정렬, 700개 주소의 보존과 정렬, 반응형 이미지 후보, 숨긴 복제본, 재수집, 스크롤, CSS·GIF·영상, Shadow DOM, iframe 좌표·접근 상태와 위치 계산 실패를 확인했습니다.
유튜브 iframe의 교차 출처·지연 로딩·영상 ID 중복 제거·유사 도메인 제외, 리뷰 썸네일의 미수집 진단, 자동 이벤트·DOM·네트워크 감시, 팝업 제거 후 보존, 감시기 해제와 외부 영상 `.url` 저장도 모의 환경에서 검증합니다.
재생 없는 리뷰 수집은 초기 JSON·React 상태·지연 스크립트·서명 URL 보존·확장자 없는 소스 구분·관찰된 GET 목록 재조회·POST 재전송 방지·403·크기 제한·응답 대기 제한·관찰 해제를 확인했습니다.
실제 로컬 HTTP 리뷰 응답을 페이지에서 정상 소비하면서 같은 원본 영상 URL을 수집하는 사례도 포함합니다. 쿠팡 서버의 실제 응답 구조에서의 성공을 검증한 것은 아닙니다.
영상 전용 다운로드 도구는 URL 분류, 순번·서명 보존, subprocess 인자 전달, 결과 파일 확인, 실패 기록을 검증합니다. 실제 YouTube 다운로드는 이 환경에서 검증하지 못했습니다.
HLS 병합은 실제 로컬 HTTP 서버의 중첩 재생목록·상대 TS 주소·음성이 있는 영상·무음 영상에서 확인했습니다. MP4를 디코딩한 프레임 해시를 원본 HLS와 비교하며, 403 뒤의 다음 영상 저장·임시 파일 정리·보고서 재사용·원래 순번 보존도 검증합니다.
SVG 내부 참조 제외는 절대 주소·CSS 이스케이프·별도의 base URI·iframe 문서에서 검증했으며, 외부 SVG 및 data 이미지 주소는 유지합니다.
Mercury 이벤트 주소 제외는 네트워크·DOM·CSS 경로와 재수집에서 검증했습니다. 392개 이미지 후보와 CSS GIF 한 개를 보존하면서 이벤트 주소 67개를 분리하는 모의 사례와, 일반 GIF를 fetch/XHR로 수집하는 사례도 포함합니다.
테스트는 위치·표시 상태를 지정한 모의 DOM에서 수행하며, 실제 브라우저의 렌더링이나 쿠팡 페이지에서 새 정렬 기능을 검증한 기록은 아닙니다.
Video.js 보완은 DOM에 blob만 있는 재생기의 원본 소스·긴 쿼리 문자열 보존, 선택 소스와 대체 소스 구분, 확장자 없는 HLS·DASH, 기존 재생기 조회, 접근 오류, 지연 로딩 후 재수집, 닫힌 팝업의 주소 보존, iframe 좌표와 오디오 제외를 모의 재생기에서 확인했습니다.
재생기에서 찾은 원본 MP4 주소로 브라우저 ZIP 다운로드를 진행하고 받은 바이트를 보존하는 사례도 포함합니다.
쿠팡 상품 페이지의 DOM·재생기 API에서 원본 주소를 찾는 과정은 이 환경에서 직접 검증하지 못했습니다.
제공된 다운로드 보고서의 쿠팡 CDN m3u8 두 개는 원본 서버에 접속해 MP4로 병합하고 FFprobe 및 전체 영상·음성 디코딩 검사를 수행했습니다. 상품 페이지 수집 검증과 원본 CDN 다운로드 검증은 별도 범위입니다.
목록 파일 내보내기는 긴 URL의 전체 문자열 보존·순서·선택 주소 필터·Blob을 통한 한 파일의 저장 요청을 모의 환경에서 검증했습니다. 실제 브라우저의 다운로드 UI는 검증하지 않았습니다.
브라우저 ZIP 기능은 원본 바이트·순번·확장자 보정, OK·HTML·JSON·HTTP 오류·읽을 수 없는 응답 제외, 대상 범위, ZIP 분할, 크기 제한, 요청 시간 제한, 중단·동시 실행 방지와 재생목록 구분을 포함합니다.

실제 로컬 HTTP 서버에서 700개 애니메이션 GIF와 403 주소 한 개를 처리한 ZIP 통합 테스트도 있습니다.
개발 환경의 Python 표준 라이브러리 `zipfile`로 모든 파일의 CRC·압축 해제·원본 바이트·순번·실패 보고서를 독립적으로 확인합니다. Python은 이 검증 도구에만 필요하며, 브라우저 ZIP 기능 사용에는 필요하지 않습니다.

```sh
node --test tests/zip-download.test.cjs
```

이 통합 테스트의 다운로드는 Node.js의 fetch·스트림을 사용합니다. 브라우저의 실제 CORS 강제 적용이나 실제 다운로드 UI를 검증한 결과는 아닙니다.
현재 환경에서는 브라우저 실행 파일을 준비하지 못해 실제 Chrome/Edge의 ZIP 다운로드는 직접 검증하지 못했습니다.

Python 다운로드 도구 테스트는 임시 폴더에 결과를 저장하며, Python이 설치된 개발 환경에서 아래 명령으로 실행합니다.

```sh
python -m unittest discover -s tests -p test_downloader.py -v
```

12개 테스트로 로컬 HTTP 서버에서의 실제 다운로드, GIF 원본 바이트 보존, 확장자 보정, OK·HTML·JSON 제외, 403/404, 중간에 끊긴 응답, 리다이렉트, Referer, 재생목록, data/blob URL, 동시 다운로드 후의 순번, 실패 보고서와 기존 폴더 보존 및 유튜브 시청 주소의 바로가기 저장을 확인했습니다.
다운로드 로직과 명령줄 실행은 Linux의 Python 3.12에서 검증했습니다. Windows용 `.cmd` 실행 파일은 코드를 검토했으며, Windows에서 직접 실행하지는 못했습니다.

PowerShell 다운로드 도구는 로컬 HTTP 서버와 10개 통합 테스트로 실제 파일 바이트·순번·확장자 보정, 리다이렉트·Referer, 보고서 재사용·실패 항목 재시도, CSV·텍스트 목록, data 주소·큰 data 주소, 오류 응답·재생목록 구분, 크기 제한, 끊긴 응답, 요청·본문 읽기 시간 제한과 기존 폴더 보존을 확인했습니다.

```sh
python -m unittest discover -s tests -p test_powershell.py -v
```

이 명령은 개발 테스트에만 Python과 PowerShell이 필요합니다. 사용자용 다운로드 도구는 Python을 사용하지 않습니다.
PATH의 `powershell` 또는 `pwsh`를 사용하며, `SCRAPER_TEST_POWERSHELL` 환경 변수로 테스트 실행 파일을 지정할 수도 있습니다.
테스트는 Linux의 PowerShell 7.4.6에서 실행했습니다. Windows PowerShell 5.1과 Windows `.cmd` 실행은 직접 검증하지 못했습니다.
실제 쿠팡 보고서에서 브라우저 다운로드가 실패했던 HTTPS 상품 JPEG 한 개와 CSS GIF 한 개도 PowerShell 도구로 저장했고, 인라인 SVG 한 개를 함께 저장했습니다.
이 표본은 당시 해당 주소의 다운로드를 확인한 결과이며, 전체 목록이나 모든 서버의 다운로드 성공을 보장하지 않습니다.

## GIF 주소를 열었는데 OK 텍스트만 보이는 경우

URL의 `.gif` 확장자만으로 실제 GIF 파일인지 확인할 수는 없습니다. 서버가 그 주소에서 텍스트 응답을 보낼 수도 있습니다.
브라우저는 응답의 `Content-Type`과 실제 데이터를 바탕으로 내용을 처리합니다. [MIME 유형 설명](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/MIME_types)을 참고하세요.

`mercury.coupang.com/e.gif`가 네트워크 기록에 반복되고 `OK`만 응답한다면, 상품 이미지보다 통계·이벤트 수집 요청으로 볼 근거가 있습니다.
수정본은 이 주소를 미디어에서 제외하고 별도 진단 목록으로 기록합니다. 목록을 분리해도 페이지 자체의 통계 전송 동작은 계속됩니다.
이 필터가 다른 사이트의 모든 통계 요청을 판별하는 것은 아니며, 다른 `.gif` 주소의 파일 형식이나 실제 애니메이션 여부까지 검사하지는 않습니다.

콘솔 표에 표시된 `…`는 긴 주소가 생략된 부분일 수 있습니다. 해당 표시를 포함한 링크를 복사하면 원래 주소와 달라집니다.
아래 명령으로 생략 없는 GIF 후보 주소를 복사합니다.

```js
copy(mediaGrab.rows.filter(x => x.type === 'GIF').map(x => x.url).join('\n'))
```

수정본을 적용할 때는 파일의 전체 코드를 다시 실행해 이전 수집 기록을 초기화합니다.

## 수집 주소를 직접 열었을 때 Access Denied가 나오는 경우

수집 코드는 페이지에 노출된 주소를 읽습니다. 수집 단계에서 해당 주소에 HTTP 요청을 보내서 접속·다운로드 성공까지 확인하는 기능은 없습니다.
`visible: true`도 요소의 배치와 선택 주소를 바탕으로 판단한 값이며, 이미지 로딩이나 직접 다운로드 성공을 뜻하지 않습니다.

- 먼저 `http://` 주소 대신 페이지에서 사용한 `https://` 주소가 있는지 확인합니다. 원본 URL을 임의로 일괄 변경하지는 않습니다.
- `https://`에서도 403/Access Denied가 나오면 주소만으로는 서버의 접근 조건을 충족하지 못한 것입니다. 요청 출처(Referer), 쿠키·세션, IP·보안 정책 등이 원인일 수 있지만 에러 문구만으로 어느 조건 때문인지 확정할 수는 없습니다.
- 에러 본문에 `http://`가 표시되더라도 실제로 HTTP로 요청했다고 단정할 수 없습니다. HTTPS 요청의 에러 본문에도 같은 문구가 나올 수 있습니다. 실제 요청 주소는 개발자도구 Network에서 확인합니다.
- 상품 페이지 안에서는 이미지가 정상적으로 보인다면 해당 이미지에서 브라우저의 **이미지를 다른 이름으로 저장**을 시도할 수 있습니다. 이것도 서버 정책에 따라 성공 여부가 달라집니다.
- 콘솔 표의 `…`는 주소 표시가 생략된 부분일 수 있습니다. 완전한 주소는 `copy(JSON.stringify(mediaGrab.rows, null, 2))`로 복사합니다.

HTTP 오류나 직접 접근 제한은 URL 수집·정렬 코드를 바꾸는 것만으로 해제할 수 없습니다.
수집기 수정본을 적용할 때는 파일의 전체 코드를 다시 실행해 이전 수집 기록도 초기화합니다.

## 확인한 범위와 제한

- `collect-page-media.js`는 URL 수집·목록 내보내기·브라우저 ZIP 다운로드를 담당합니다. 목록 파일을 `download-media.ps1` 또는 `download-media.py`로 다운로드할 수도 있으며, 방식별 읽기 권한·지원하는 응답 형식·서버 접근 조건에 따라 저장 여부가 달라집니다.
- 펼치지 않았거나 아직 로딩하지 않아 DOM·Resource Timing에 주소가 없는 미디어는 수집할 수 없습니다.
- 다른 출처의 iframe 내부는 브라우저의 동일 출처 정책으로 접근이 제한될 수 있습니다. `blockedFrames`를 확인하고, 필요한 상세 iframe을 개발자도구의 실행 컨텍스트에서 선택해 같은 코드를 따로 실행한 뒤 결과를 모읍니다.
- 파일 형식은 URL과 요소 정보를 바탕으로 추정합니다. 확장자가 없는 GIF나 애니메이션 WebP/APNG는 `IMAGE`로 표시될 수 있습니다. `img`에 노출된 주소는 확장자가 없어도 수집하지만, 실제 애니메이션 여부를 검사하지는 않습니다.
- `STREAM`은 재생목록 주소이며 완성된 MP4 파일 주소와 다릅니다. `blob:` 주소는 페이지 세션에 의존하며 원본 파일 주소가 아닐 수 있습니다.
- 닫힌 Shadow DOM, 주소가 노출되지 않는 canvas/인라인 SVG 그림, DRM 미디어의 원본 파일 주소는 이 방식으로 보장할 수 없습니다.
- 로그인·캡챠·접속 오류를 자동으로 통과하는 기능은 없습니다. 상품 내용이 정상적으로 보이는 상태에서 실행합니다.

## 사이트 테스트 기록

2026-10-03 (한국 시간)까지 대화에서 수행한 테스트 중, 상세 검증 결과가 보관된 사례입니다.
아래 기록은 **좌표 정렬 기능을 추가하기 전 버전의 URL 수집 테스트**입니다.

| 사이트 | 확인 결과 | 검증 범위 |
|---|---|---|
| 무신사 상품 `6992032` | 상세 이미지 14개 주소 누락 0개. 14개 실제 파일이 모두 JPEG. 확장자 없는 주소 13개도 수집. 전체 수집 주소 215개 | 상세내용을 전부 확장한 뒤, 페이지의 DOM 이미지 주소와 수집 결과를 대조 |
| SSG 상품 `1000884823950` | 상세 이미지 요소 28개, 중복 제외 25개 이미지 주소 누락 0개. 메인·상세 결과를 합치면 224개 주소 | 메인 페이지와 상세 iframe에서 각각 수집해 병합. 단일 실행의 iframe 자동 수집은 미검증 |
| CJ온스타일 `M1176746` | 9개 상품 상세창의 이미지 요소 49개, 중복 제외 20개 `img` 주소 누락 0개. CSS 이미지도 추가 수집 | 각 상세 iframe을 따로 검사. 단일 실행의 iframe 자동 수집은 미검증 |

테스트에서는 브라우저의 **읽기 전용 DOM 검사 환경**에서 같은 수집 함수를 실행했습니다.
검사 환경에서 사용할 수 없는 `window`/`console`에는 로컬 대체 객체를 사용하고, `baseURI`를 보완했습니다.
실제 DevTools 콘솔 실행, 실제 페이지 전역 변수 등록, 클립보드 복사, iframe 자동 재귀와 Resource Timing 수집은 이 환경에서 직접 검증하지 못했습니다.
무신사 상세내용에는 GIF·영상이 없었으므로 그 페이지로 GIF·영상 추출을 검증했다고 해석하면 안 됩니다.

검증 기록은 특정 페이지의 당시 상태에 대한 결과이며, 모든 사이트의 모든 미디어 수집을 보장하는 결과는 아닙니다.
