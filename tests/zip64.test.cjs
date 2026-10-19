const assert = require('node:assert/strict');
const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(resolve(__dirname, '../collect-page-media.js'), 'utf8');
function writer(BlobClass = Blob) {
  const window = {}, document = { defaultView: window, URL: 'https://test.example/', baseURI: 'https://test.example/', querySelectorAll: () => [] };
  const context = vm.createContext({ window, document, URL, Blob: BlobClass, TextEncoder, TextDecoder,
    console: { log() {}, table() {} } });
  // Expose the production writer only in the test harness; no test hooks ship in the snippet.
  vm.runInContext(source.replace('const requestSave =', 'window.testZipWriter = makeZip; const requestSave ='), context);
  return window.testZipWriter;
}

test('ZIP64 stores the complete 65,535-entry directory and exposes a fixture for independent readers', () => {
  const empty = new Blob([]), count = 65535;
  const entries = Array.from({ length: count }, (_, i) => ({ name: `${i}.bin`, size: 0, crc: 0, blob: empty }));
  class PartsOnlyBlob { constructor(parts) { this.parts = parts; this.size = parts.reduce((n, p) => n + (p.size ?? p.byteLength), 0); } }
  const packed = writer(PartsOnlyBlob)(entries);
  // Flatten only the real header bytes; the 65,535 payloads are genuinely empty.
  const bytes = Buffer.concat(packed.parts.filter(p => p.byteLength).map(p => Buffer.from(p)));
  assert.equal(bytes.readUInt32LE(bytes.length - 42), 0x07064b50);
  const locator = bytes.length - 42, recordAt = Number(bytes.readBigUInt64LE(locator + 8));
  assert.equal(bytes.readUInt32LE(recordAt), 0x06064b50);
  assert.equal(bytes.readBigUInt64LE(recordAt + 24), BigInt(count));
  assert.equal(bytes.readBigUInt64LE(recordAt + 32), BigInt(count));
  const directoryAt = Number(bytes.readBigUInt64LE(recordAt + 48));
  let at = directoryAt;
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(at), 0x02014b50);
    const n = bytes.readUInt16LE(at + 28);
    assert.equal(bytes.subarray(at + 46, at + 46 + n).toString(), `${i}.bin`);
    at += 46 + n + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  assert.equal(at, recordAt);
  if (process.env.SCRAPER_ZIP64_FIXTURE) writeFileSync(process.env.SCRAPER_ZIP64_FIXTURE, bytes);
});

test('ZIP64 preserves file sizes and subsequent offsets beyond 4 GiB without truncating 64-bit fields', () => {
  // Virtual payloads exercise >4 GiB header/offset arithmetic without allocating gigabytes.
  class VirtualBlob {
    constructor(parts) { this.parts = parts; this.size = parts.reduce((n, p) => n + (p.size ?? p.byteLength), 0); }
  }
  const large = 0x100000000 + 17, blob = writer(VirtualBlob)([
    { name: 'large.mp4', size: large, crc: 0x12345678, blob: { size: large } },
    { name: 'next.gif', size: 1, crc: 0, blob: { size: 1 } }
  ]);
  const local = new DataView(blob.parts[0].buffer), centralFirst = new DataView(blob.parts[4].buffer);
  assert.equal(local.getUint16(4, true), 45);
  assert.equal(local.getUint32(18, true), 0xffffffff);
  const localExtra = 30 + local.getUint16(26, true);
  assert.equal(local.getUint16(localExtra, true), 1);
  assert.equal(local.getBigUint64(localExtra + 4, true), BigInt(large));
  assert.equal(local.getBigUint64(localExtra + 12, true), BigInt(large));
  assert.equal(centralFirst.getUint32(20, true), 0xffffffff);
  const second = new DataView(blob.parts[5].buffer), secondExtra = 46 + second.getUint16(28, true);
  assert.equal(second.getUint32(42, true), 0xffffffff);
  assert.equal(second.getBigUint64(secondExtra + 4, true), BigInt(blob.parts[0].length + large));
  const record = new DataView(blob.parts[6].buffer), locator = new DataView(blob.parts[7].buffer);
  assert.equal(record.getUint32(0, true), 0x06064b50);
  assert.equal(record.getBigUint64(4, true), 44n);
  assert.equal(record.getBigUint64(32, true), 2n);
  const centralOffset = blob.parts[0].length + large + blob.parts[2].length + 1;
  assert.equal(record.getBigUint64(48, true), BigInt(centralOffset));
  assert.equal(locator.getBigUint64(8, true), BigInt(centralOffset + blob.parts[4].length + blob.parts[5].length));
});

test('ZIP writer rejects inconsistent payload sizes instead of emitting an apparently valid corrupt archive', () => {
  assert.throws(() => writer()([{ name: 'bad.mp4', size: 20, crc: 0, blob: new Blob(['short']) }]), /실제 데이터/);
});
