// Developer integration test: Node.js fetch/streams plus Python stdlib ZIP
// validation. This does not test browser CORS enforcement or the download UI.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const http = require('node:http');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const vm = require('node:vm');

const script = readFileSync(resolve(__dirname, '../collect-page-media.js'), 'utf8');
// A two-frame red/blue GIF; downloading must retain both original frames.
const animated = Buffer.from('R0lGODlhAgACAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAgACAAAIBgABCAQQEAAh+QQBCgABACwAAAAAAgACAIEAAP8AAAAAAAAAAAAIBgABCAQQEAA7', 'base64');

test('700 real HTTP downloads form an intact ZIP with unchanged animated GIFs and a failed-address report', async t => {
  let requests = 0, savedBlob, saveRequests = 0;
  const server = http.createServer((request, response) => {
    requests++;
    if (request.url === '/denied.jpg') {
      response.writeHead(403, { 'Content-Type': 'text/html' });
      response.end('<html>Access Denied</html>');
    } else {
      response.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': animated.length });
      response.end(animated);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/product`;
  const resources = Array.from({ length: 700 }, (_, i) => ({ name: new URL(`/animation-${i}.gif`, base).href, initiatorType: 'img' }));
  resources.push({ name: new URL('/denied.jpg', base).href, initiatorType: 'img' });
  const window = { scrollX: 0, scrollY: 0, performance: { getEntriesByType: () => resources } };
  const doc = {
    URL: base, baseURI: base, title: '상품 700개', defaultView: window,
    querySelectorAll: () => [], body: { appendChild() {} },
    createElement: () => ({ style: {}, click() { saveRequests++; }, remove() {} })
  };
  const urls = class extends URL {
    static createObjectURL(blob) { savedBlob = blob; return 'blob:integration-archive'; }
    static revokeObjectURL() {}
  };
  const context = vm.createContext({ window, document: doc, URL: urls, Blob,
    TextEncoder, TextDecoder, AbortController, fetch, setTimeout, clearTimeout,
    console: { table() {}, log() {} } });
  vm.runInContext(script, context);
  const report = await window.mediaGrab.download();
  assert.equal(requests, 701);
  assert.equal(saveRequests, 1);
  assert.equal(report.archives.length, 1);
  assert.equal(report.results.filter(row => row.status === 'packed').length, 700);
  assert.equal(report.results[700].httpStatus, 403);
  const verifier = String.raw`
import base64, csv, io, json, sys, zipfile
original = base64.b64decode('${animated.toString('base64')}')
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
    assert archive.testzip() is None
    media = [name for name in archive.namelist() if name[:1].isdigit()]
    assert media == [f'{number:04d}.gif' for number in range(1, 701)]
    for name in media:
        assert archive.read(name) == original, name
    report = json.loads(archive.read('download-report.json'))
    assert len(report['results']) == 701
    assert report['results'][-1]['httpStatus'] == 403
    failures = list(csv.DictReader(io.StringIO(archive.read('failed.csv').decode('utf-8-sig'))))
    assert len(failures) == 1 and failures[0]['httpStatus'] == '403'
print(json.dumps({'gif_files': len(media), 'crc_verified': True, 'failures': len(failures)}))
`;
  const verified = spawnSync(process.env.SCRAPER_TEST_PYTHON || 'python', ['-c', verifier], {
    input: Buffer.from(await savedBlob.arrayBuffer()), encoding: 'utf8'
  });
  assert.equal(verified.status, 0, verified.stderr || String(verified.error));
  assert.deepEqual(JSON.parse(verified.stdout), { gif_files: 700, crc_verified: true, failures: 1 });
});
