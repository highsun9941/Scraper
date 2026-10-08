// Integration checks use real H.264/AAC TS bytes over local HTTP and independent
// FFmpeg decoding. Node fetch does not enforce browser CORS or exercise save UI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const vm = require('node:vm');
const script = fs.readFileSync(resolve(__dirname, '../collect-page-media.js'), 'utf8');
const ffmpeg = process.env.SCRAPER_TEST_FFMPEG || 'ffmpeg';
const ffprobe = process.env.SCRAPER_TEST_FFPROBE || 'ffprobe';
const available = spawnSync(ffmpeg, ['-version']).status === 0 && spawnSync(ffprobe, ['-version']).status === 0;
const mediaTest = (name, fn) => test(name, { skip: !available && 'FFmpeg/FFprobe are needed only for developer verification' }, fn);

function encode(folder, name, audio = true) {
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=10'];
  if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=500:sample_rate=48000');
  args.push('-t', '2', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-g', '10', '-sc_threshold', '0');
  if (audio) args.push('-c:a', 'aac');
  args.push('-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod', join(folder, name + '.m3u8'));
  const result = spawnSync(ffmpeg, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || String(result.error));
}
function runtime(base, resources, fetcher = fetch) {
  const archives = [];
  const window = { scrollX: 0, scrollY: 0, performance: { getEntriesByType: () =>
    resources.map(name => ({ name: new URL(name, base).href, initiatorType: 'video' })) } };
  const doc = { URL: base, baseURI: base, defaultView: window, title: 'HLS fixture',
    querySelectorAll: () => [], body: { appendChild() {} },
    createElement: () => ({ style: {}, click() {}, remove() {} }) };
  const urls = class extends URL {
    static createObjectURL(blob) { archives.push(blob); return 'blob:archive-' + archives.length; }
    static revokeObjectURL() {}
  };
  const context = vm.createContext({ window, document: doc, URL: urls, Blob, TextEncoder, TextDecoder,
    AbortController, fetch: fetcher, setTimeout, clearTimeout, console: { log() {}, table() {} } });
  vm.runInContext(script, context);
  return { grab: window.mediaGrab, archives };
}
async function serve(t, handler) {
  const requests = [];
  const server = http.createServer((request, response) => { requests.push(request.url); handler(request, response); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { base: `http://127.0.0.1:${server.address().port}/product`, requests };
}
async function unzip(blob) {
  const result = spawnSync(process.env.SCRAPER_TEST_PYTHON || 'python', ['-c', String.raw`
import base64, io, json, sys, zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as z:
    assert z.testzip() is None
    print(json.dumps({name:base64.b64encode(z.read(name)).decode() for name in z.namelist()}))
`], { input: Buffer.from(await blob.arrayBuffer()), encoding: 'utf8', maxBuffer: 20 * 1024 ** 2 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return Object.fromEntries(Object.entries(JSON.parse(result.stdout)).map(([name, bytes]) => [name, Buffer.from(bytes, 'base64')]));
}
const mediaFiles = files => Object.keys(files).filter(name => /^\d/.test(name));
function decodeHashes(path) {
  const result = spawnSync(ffmpeg, ['-v', 'error', '-threads', '1', '-i', path, '-map', '0:v:0', '-f', 'framemd5', '-'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.equal(result.stderr, '');
  return result.stdout.split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1).trim());
}

mediaTest('console HLS selects supported signed variants and preserves every frame, audio and original numbering in a valid ZIP', async t => {
  const folder = fs.mkdtempSync(join(tmpdir(), 'scraper-hls-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  encode(folder, 'av'); encode(folder, 'silent', false);
  const avList = fs.readFileSync(join(folder, 'av.m3u8'), 'utf8').replace(/av([01])\.ts/g, '../av$1.ts?token=seg%2B$1');
  const resources = ['/thumbnail.jpg', '/master.m3u8?token=root%2Bsig', '/silent.m3u8'];
  const server = await serve(t, (request, response) => {
    resources.push(request.url); // Resource Timing retains the downloader's own requests.
    response.setHeader('Access-Control-Allow-Origin', '*');
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/master.m3u8') {
      response.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=999999,CODECS="hvc1.1.6.L93.B0,mp4a.40.2"\nwrong.m3u8\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=100000,CODECS="avc1.64000a,mp4a.40.2"\nvariants/av.m3u8?token=a%2Bb\n');
    } else if (path === '/variants/av.m3u8') response.end(avList);
    else if (/^\/(?:av|silent)(?:[01]\.ts|\.m3u8)$/.test(path)) response.end(fs.readFileSync(join(folder, path.slice(1))));
    else assert.fail('unexpected request ' + request.url);
  });
  const { grab, archives } = runtime(server.base, resources);
  const report = await grab.downloadHls();
  assert.deepEqual(Array.from(report.results, row => [row.order, row.status, row.filename, row.hasAudio]), [
    [2, 'packed', '0002.mp4', true], [3, 'packed', '0003.mp4', false]
  ]);
  assert.ok(server.requests.includes('/master.m3u8?token=root%2Bsig'));
  assert.ok(server.requests.includes('/variants/av.m3u8?token=a%2Bb'));
  assert.ok(server.requests.includes('/av0.ts?token=seg%2B0'));
  assert.ok(!server.requests.some(path => /thumbnail|wrong/.test(path)));
  assert.deepEqual(Array.from(grab.getManifest().items, row => new URL(row.url).pathname),
    ['/thumbnail.jpg', '/master.m3u8', '/silent.m3u8']);
  resources.push('/new-image.jpg');
  assert.equal(grab.getManifest().items.length, 4, 'unrelated new resources must still be collected');
  const files = await unzip(archives[0]);
  assert.deepEqual(mediaFiles(files), ['0002.mp4', '0003.mp4']);
  for (const [name, original, audio] of [['0002.mp4', 'av', true], ['0003.mp4', 'silent', false]]) {
    const output = join(folder, name); fs.writeFileSync(output, files[name]);
    const hashes = decodeHashes(output);
    assert.equal(hashes.length, 20);
    assert.deepEqual(hashes, decodeHashes(join(folder, original + '.m3u8')));
    const decoded = spawnSync(ffmpeg, ['-v', 'error', '-threads', '1', '-i', output, '-map', '0:v:0', '-map', '0:a:0?', '-f', 'null', '-'], { encoding: 'utf8' });
    assert.equal(decoded.status, 0, decoded.stderr); assert.equal(decoded.stderr, '');
    const probe = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', output], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    const info = JSON.parse(probe.stdout);
    assert.equal(info.streams.some(stream => stream.codec_type === 'audio'), audio);
    assert.ok(Number(info.format.duration) >= 1.9 && Number(info.format.duration) <= 2.3);
  }
  assert.equal(JSON.parse(files['download-report.json']).results[0].format, 'fragmented-mp4');
});

mediaTest('failed or truncated HLS never produces a partial MP4 and the next stream still succeeds', async t => {
  const folder = fs.mkdtempSync(join(tmpdir(), 'scraper-hls-failure-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true })); encode(folder, 'av');
  const server = await serve(t, (request, response) => {
    if (request.url === '/bad.m3u8') response.end('#EXTM3U\n#EXTINF:1,\nav0.ts\n#EXTINF:1,\ndenied.ts\n#EXT-X-ENDLIST\n');
    else if (request.url === '/truncated.m3u8') response.end('#EXTM3U\n#EXTINF:1,\ntruncated.ts\n#EXT-X-ENDLIST\n');
    else if (request.url === '/denied.ts') { response.writeHead(403); response.end('denied'); }
    else if (request.url === '/truncated.ts') response.end(fs.readFileSync(join(folder, 'av0.ts')).subarray(0, -1));
    else response.end(fs.readFileSync(join(folder, request.url.slice(1))));
  });
  const { grab, archives } = runtime(server.base, ['/bad.m3u8', '/truncated.m3u8', '/av.m3u8']);
  const report = await grab.downloadHls();
  assert.deepEqual(Array.from(report.results, row => row.status), ['failed', 'failed', 'packed']);
  assert.equal(report.results[0].httpStatus, 403);
  assert.match(report.results[1].message, /손상/);
  assert.deepEqual(mediaFiles(await unzip(archives[0])), ['0003.mp4']);
});

test('encrypted, live, fMP4, discontinuous, byte-range, missing and separately tracked HLS are explicit failures before requesting media', async t => {
  const cases = {
    '/key.m3u8': '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:1,\none.ts\n#EXT-X-ENDLIST',
    '/live.m3u8': '#EXTINF:1,\none.ts',
    '/map.m3u8': '#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\none.m4s\n#EXT-X-ENDLIST',
    '/discontinuity.m3u8': '#EXT-X-DISCONTINUITY\n#EXTINF:1,\none.ts\n#EXT-X-ENDLIST',
    '/range.m3u8': '#EXTINF:1,\n#EXT-X-BYTERANGE:188@0\none.ts\n#EXT-X-ENDLIST',
    '/missing.m3u8': '#EXTINF:1,\n#EXT-X-ENDLIST',
    '/audio.m3u8': '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",URI="separate.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=10,AUDIO="audio"\nvideo.m3u8',
    '/codec.m3u8': '#EXT-X-STREAM-INF:BANDWIDTH=10,CODECS="hvc1.1.6.L93.B0"\nhevc.m3u8'
  };
  const server = await serve(t, (request, response) => {
    assert.ok(Object.hasOwn(cases, request.url), 'unexpected media request ' + request.url);
    response.end('#EXTM3U\n' + cases[request.url] + '\n');
  });
  const { grab, archives } = runtime(server.base, Object.keys(cases));
  const report = await grab.downloadHls();
  assert.equal(report.results.length, Object.keys(cases).length);
  assert.ok(report.results.every(row => row.status === 'failed' && row.filename === ''));
  assert.deepEqual(server.requests, Object.keys(cases));
  assert.deepEqual(mediaFiles(await unzip(archives[0])), []);
});

test('HLS cycle, DASH and unreadable responses are recorded without claiming a video', async t => {
  const server = await serve(t, (request, response) => {
    if (request.url === '/dash.mpd') response.end('<MPD></MPD>');
    else response.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\ncycle.m3u8\n');
  });
  const { grab, archives } = runtime(server.base, ['/cycle.m3u8', '/dash.mpd', '/cors.m3u8'], (url, options) => {
    if (new URL(url).pathname === '/cors.m3u8') return Promise.reject(new TypeError('Failed to fetch'));
    return fetch(url, options);
  });
  const report = await grab.downloadHls();
  assert.deepEqual(Array.from(report.results, row => row.status), ['failed', 'failed', 'failed']);
  assert.match(report.results[0].message, /순환/);
  assert.match(report.results[1].message, /DASH/);
  assert.match(report.results[2].message, /CORS/);
  assert.equal(server.requests.filter(path => path === '/cycle.m3u8').length, 2);
  assert.deepEqual(mediaFiles(await unzip(archives[0])), []);
});

mediaTest('redirected playlist uses its final URL as the base and enforces the total TS byte limit', async t => {
  const folder = fs.mkdtempSync(join(tmpdir(), 'scraper-hls-redirect-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true })); encode(folder, 'av');
  const server = await serve(t, (request, response) => {
    if (request.url === '/redirect.m3u8') { response.writeHead(302, { Location: '/nested/av.m3u8' }); response.end(); }
    else if (request.url.startsWith('/nested/')) response.end(fs.readFileSync(join(folder, request.url.slice(8))));
    else assert.fail('incorrect relative base ' + request.url);
  });
  const { grab, archives } = runtime(server.base, ['/redirect.m3u8']);
  const report = await grab.downloadHls({ maxFileMB: 0.001 });
  assert.equal(report.results[0].status, 'failed');
  assert.match(report.results[0].message, /크기 제한/);
  assert.ok(server.requests.includes('/nested/av0.ts'));
  assert.deepEqual(mediaFiles(await unzip(archives[0])), []);
});

test('aborted HLS stops outstanding reads and rejects overlapping download operations', async t => {
  const server = await serve(t, (_request, response) => {
    response.write('#EXTM3U\n'); // A deliberately unfinished response.
  });
  const { grab, archives } = runtime(server.base, ['/wait.m3u8']);
  const running = grab.downloadHls();
  await assert.rejects(grab.downloadHls(), /이미 다운로드/);
  grab.stopDownload();
  const report = await running;
  assert.equal(report.cancelled, true);
  assert.equal(report.results[0].status, 'skipped');
  assert.deepEqual(mediaFiles(await unzip(archives[0])), []);
});

test('HLS metadata size and nested playlist limits stop before requesting more children', async t => {
  const server = await serve(t, (request, response) => {
    if (request.url === '/large.m3u8') response.end('#EXTM3U\n' + '\n'.repeat(2 * 1024 ** 2));
    else {
      const depth = Number(request.url.match(/depth(\d+)/)[1]);
      response.end(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\ndepth${depth + 1}.m3u8\n`);
    }
  });
  const { grab, archives } = runtime(server.base, ['/large.m3u8', '/depth0.m3u8']);
  const report = await grab.downloadHls();
  assert.deepEqual(Array.from(report.results, row => row.status), ['failed', 'failed']);
  assert.match(report.results[0].message, /크기 제한/);
  assert.match(report.results[1].message, /중첩 제한/);
  assert.equal(server.requests.filter(path => path.startsWith('/depth')).length, 5);
  assert.deepEqual(mediaFiles(await unzip(archives[0])), []);
});
