const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const script = readFileSync(resolve(__dirname, '../collect-page-media.js'), 'utf8');
const base = 'https://shop.example/product';
const url = name => new URL(name, base).href;

// Deterministic layout fixtures, not a browser renderer. Tests exercise the
// public output against declared page positions, selection and clipping.
function fixture({ scrollX = 0, scrollY = 0, resources = [], documentURL = base, baseURI = base } = {}) {
  const doc = { URL: documentURL, baseURI, ownerDocument: null };
  const style = (el, pseudo) => {
    if (el.styleError) throw new Error('unavailable style');
    const inherited = el.parentElement ? style(el.parentElement).visibility :
      el._root?.host ? style(el._root.host).visibility : 'visible';
    const values = {
      display: 'block', visibility: inherited, opacity: '1',
      overflowX: 'visible', overflowY: 'visible', content: 'none',
      ...(pseudo ? el.pseudos[pseudo] : el.styles)
    };
    return { ...values, getPropertyValue: key => values[key] || '' };
  };
  doc.defaultView = {
    scrollX, scrollY,
    performance: { getEntriesByType: () => resources },
    getComputedStyle: style
  };
  function descendants(root) {
    return root.children.flatMap(child => [child, ...descendants(child)]);
  }
  function element(tag, options = {}) {
    const attrs = options.attrs || {};
    const el = {
      localName: tag, ownerDocument: doc, baseURI, parentElement: null,
      attrs, styles: options.styles || {}, pseudos: options.pseudos || {}, children: [],
      currentSrc: options.currentSrc ?? (['img', 'video'].includes(tag) ? attrs.src || '' : ''),
      type: attrs.type || '', src: attrs.src || '',
      rect: { top: 0, left: 0, width: 80, height: 80, ...options.rect },
      getAttribute: name => attrs[name] ?? null,
      getBoundingClientRect() {
        if (this.rectError) throw new Error('unavailable geometry');
        return { ...this.rect,
          top: this.rect.top - doc.defaultView.scrollY,
          left: this.rect.left - doc.defaultView.scrollX };
      },
      getRootNode() { return this.parentElement?.getRootNode() || this._root || doc; },
      querySelectorAll() { return descendants(this); },
      querySelector(tagName) { return descendants(this).find(child => child.localName === tagName) || null; },
      append(...children) {
        for (const child of children) {
          child.parentElement = this;
          this.children.push(child);
        }
        return this;
      }
    };
    return el;
  }
  doc.documentElement = element('html', { rect: { width: 1200, height: 20000 } });
  doc.body = element('body', { rect: { width: 1200, height: 20000 } });
  doc.documentElement.append(doc.body);
  doc.querySelectorAll = () => [doc.documentElement, ...descendants(doc.documentElement)];
  function img(name, top, left = 0, options = {}) {
    return element('img', { ...options, attrs: { src: name, ...options.attrs },
      rect: { top, left, ...options.rect } });
  }
  function shadow(host, ...children) {
    const root = { ownerDocument: doc, host, children, querySelectorAll() { return descendants(this); } };
    for (const child of children) child._root = root;
    host.shadowRoot = root;
    return root;
  }
  const context = vm.createContext({
    window: doc.defaultView, document: doc, URL, console: { table() {}, log() {} }
  });
  const run = () => {
    vm.runInContext(script, context);
    return doc.defaultView.mediaGrab;
  };
  return { doc, element, img, shadow, run, context };
}
const urls = grab => Array.from(grab.urls);
const visible = grab => Array.from(grab.visibleUrls);

test('Amazon impression endpoints are excluded without discarding displayed advertising images', () => {
  const tracking = 'https://aax-us-east-retail-direct.amazon.com/e/is/ABC0123/impb?w=0&bi=tracking';
  const image = 'https://aax-us-east-retail-direct.amazon.com/images/displayed.gif';
  const f = fixture({ resources: [{ name: tracking, initiatorType: 'img' }, { name: image, initiatorType: 'img' }] });
  const grab = f.run();
  assert.deepEqual(urls(grab), [image]);
  assert.equal(grab.excludedRows[0].url, tracking);
});

test('unreferenced historical MediaSource entries do not become downloadable videos', () => {
  const f = fixture({ resources: [{ name: 'blob:https://shop.example/expired-player', initiatorType: 'video' }] });
  const current = 'blob:https://shop.example/current-player';
  f.doc.body.append(f.element('video', { currentSrc: current }));
  assert.deepEqual(urls(f.run()), [current]);
});

test('visible inline SVGs retain vector markup, pixel dimensions and namespaces without event handlers', () => {
  const f = fixture(), svg = f.element('svg', { attrs: { viewBox: '0 0 24 24', onclick: 'unsafe()' } });
  svg.cloneNode = () => {
    const attrs = { ...svg.attrs };
    return { localName: 'svg', attrs, querySelectorAll: () => [],
      get attributes() { return Object.keys(attrs).map(name => ({ name })); },
      setAttribute(name, value) { attrs[name] = value; }, removeAttribute(name) { delete attrs[name]; } };
  };
  f.context.XMLSerializer = class {
    serializeToString(node) { return '<svg ' + Object.entries(node.attrs).map(([key, value]) => key + '="' + value + '"').join(' ') + '></svg>'; }
  };
  f.doc.body.append(svg);
  const grab = f.run(), row = grab.rows.find(row => row.source === 'svg.inline');
  assert.ok(row); assert.equal(row.type, 'IMAGE');
  const xml = decodeURIComponent(row.url.slice(row.url.indexOf(',') + 1));
  assert.match(xml, /xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(xml, /width="80"/); assert.match(xml, /height="80"/);
  assert.ok(!xml.includes('onclick'));
  assert.equal(grab.audit().inlineMediaDiagnostics.length, 0);
});

test('inline SVGs with unresolved references remain explicit coverage diagnostics', () => {
  const f = fixture(), svg = f.element('svg'), use = f.element('use', { attrs: { href: '#outside-symbol' } });
  svg.append(use); svg.cloneNode = () => assert.fail('unresolved SVG must not be exported as complete');
  f.context.XMLSerializer = class {};
  f.doc.body.append(svg);
  const grab = f.run(), audit = grab.audit();
  assert.equal(audit.inlineMediaDiagnostics.length, 1);
  assert.match(audit.inlineMediaDiagnostics[0].message, /SVG 외부 참조/);
  assert.ok(!grab.rows.some(row => row.source === 'svg.inline'));
});

function watchFixture(options = {}) {
  const f = fixture(options), mutations = [], resources = [], listeners = new Map(), intervals = new Map();
  const win = f.doc.defaultView;
  f.doc.addEventListener = (name, listener) => listeners.set(name, listener);
  f.doc.removeEventListener = (name, listener) => { if (listeners.get(name) === listener) listeners.delete(name); };
  win.MutationObserver = class {
    constructor(callback) { this.callback = callback; this.disconnected = false; mutations.push(this); }
    observe(root, options) { this.root = root; this.options = options; }
    disconnect() { this.disconnected = true; }
  };
  win.PerformanceObserver = class {
    constructor(callback) { this.callback = callback; this.disconnected = false; resources.push(this); }
    observe(options) { this.options = options; }
    disconnect() { this.disconnected = true; }
  };
  let next = 0;
  win.setInterval = callback => { intervals.set(++next, callback); return next; };
  win.clearInterval = id => intervals.delete(id);
  return { ...f, mutations, resources, listeners, intervals };
}

const reviewRoot = 'https://video.coupangcdn.com/cloud/PRODUCTREVIEW/202610/07/review-id/video-id/';
const reviewThumb = reviewRoot + 'transcode/origin_thumbnail.0000002.jpg';
const reviewVideo = reviewRoot + 'transcode/actual-720.mp4?signature=a%2Bb&expires=999';
function reviewFixture(options = {}) {
  const f = watchFixture(options), win = f.doc.defaultView;
  Object.assign(win, { AbortController, Request, setTimeout, clearTimeout });
  f.context.TextDecoder = TextDecoder;
  f.doc.body.append(f.img(reviewThumb, 900, 20));
  return f;
}

test('review hydration JSON collects signed originals without playback, clicking or network requests', async () => {
  const f = reviewFixture(), win = f.doc.defaultView;
  win.fetch = () => assert.fail('metadata must not request a video or review response');
  win.__NEXT_DATA__ = { props: { pageProps: { reviews: [{ media: { videoUrl: reviewVideo } }] } } };
  const script = f.element('script', { attrs: { type: 'application/json' } });
  script.textContent = JSON.stringify({ reviews: [{ src: reviewRoot + 'transcode/actual.m3u8?token=whole' }] }).replaceAll('/', '\\/');
  const button = f.element('button'); button.click = () => assert.fail('no review click');
  const video = f.element('video'); video.play = () => assert.fail('no playback');
  f.doc.body.append(script, button, video);
  const grab = f.run(); await grab.ready;
  assert.deepEqual(Array.from(grab.videos, row => [row.type, row.url, row.top, row.visible]), [
    ['VIDEO', reviewVideo, 900, false], ['STREAM', reviewRoot + 'transcode/actual.m3u8?token=whole', 900, false]
  ]);
  assert.equal(grab.pendingVideos.length, 0);
  assert.ok(grab.rows.some(row => row.url === reviewThumb && row.type === 'IMAGE'));
  grab.scan({ quiet: true });
  assert.equal(grab.videos[0].top, 900);
  grab.stopWatching();
});

test('review props and fiber state are read near a thumbnail while cycles, DOM and getters are ignored', () => {
  const f = reviewFixture(), thumbnail = f.doc.body.children[0];
  const state = { next: null, attachments: [{ video_url: reviewVideo }], dom: thumbnail };
  state.next = state;
  Object.defineProperty(state, 'dangerous', { get() { assert.fail('must not execute a page getter'); } });
  const fiber = { memoizedState: state }; fiber.return = fiber;
  Object.defineProperty(thumbnail, '__reactFiber$fixture', { value: fiber });
  Object.defineProperty(thumbnail, '__reactProps$fixture', { get() { assert.fail('must not read an accessor prop'); } });
  const grab = f.run();
  assert.deepEqual(Array.from(grab.videos, row => row.url), [reviewVideo]);
  assert.equal(grab.pendingVideos.length, 0);
  grab.stopWatching();
});

test('review text handles escaped JSON and HTML URLs and does not turn images into video', () => {
  const f = reviewFixture(), script = f.element('script');
  const encoded = reviewVideo.replaceAll('/', '\\u002f').replaceAll('&', '\\u0026').replaceAll('=', '\\u003d');
  script.textContent = `window.loadedReview = {url: "${encoded}"};`;
  f.doc.body.append(script);
  const grab = f.run();
  assert.deepEqual(Array.from(grab.videos, row => row.url), [reviewVideo]);
  assert.equal(grab.rows.find(row => row.url === reviewThumb).type, 'IMAGE');
  grab.stopWatching();
});

test('extensionless review sources need an explicit video field or media MIME', () => {
  const f = reviewFixture(), win = f.doc.defaultView;
  const hinted = reviewRoot + 'transcode/source?signature=whole', unhinted = reviewRoot + 'transcode/untyped';
  const stream = reviewRoot + 'transcode/playlist?signature=full';
  win.__INITIAL_STATE__ = { rows: [
    { videoUrl: hinted }, { url: unhinted },
    { src: stream, type: 'application/vnd.apple.mpegurl' },
    { videoUrl: reviewThumb }, { videoUrl: 'https://video.coupangcdn.com.evil.example/cloud/PRODUCTREVIEW/x.mp4' }
  ] };
  const grab = f.run();
  assert.deepEqual(Array.from(grab.videos, row => [row.type, row.url]), [['VIDEO', hinted], ['STREAM', stream]]);
  assert.ok(!grab.urls.includes(unhinted));
  grab.stopWatching();
});

test('a literal entity in a JSON media URL stays unchanged instead of generating another signed URL', () => {
  const f = reviewFixture(), exact = reviewRoot + 'transcode/file.mp4?signature=literal&amp;key=unchanged';
  f.doc.defaultView.__NEXT_DATA__ = { videoUrl: exact };
  const grab = f.run();
  assert.deepEqual(Array.from(grab.videos, row => row.url), [exact]);
  grab.stopWatching();
});

test('a newly inserted review JSON script is observed without opening its video', () => {
  const f = reviewFixture(), grab = f.run();
  const script = f.element('script', { attrs: { type: 'application/json' } });
  script.textContent = JSON.stringify({ videoUrl: reviewVideo });
  f.doc.body.append(script);
  f.mutations[0].callback([{ target: f.doc.body, addedNodes: [script], removedNodes: [] }]);
  assert.deepEqual(Array.from(grab.videos, row => row.url), [reviewVideo]);
  assert.equal(grab.pendingVideos.length, 0);
  grab.stopWatching();
});

test('review fetch observation preserves the original Promise, Response and body', async () => {
  const f = reviewFixture(), win = f.doc.defaultView;
  const body = JSON.stringify({ reviews: [{ videoUrl: reviewVideo }] });
  const response = new Response(body, { headers: { 'Content-Type': 'application/json' } });
  const promise = Promise.resolve(response), calls = [];
  const original = function (...args) { calls.push({ receiver: this, args }); return promise; };
  win.fetch = original;
  const grab = f.run();
  const options = { method: 'GET', headers: { 'X-Test': 'unchanged' } };
  const result = win.fetch('/api/reviews?productId=1', options);
  assert.equal(result, promise);
  assert.equal(await result, response);
  assert.equal(await response.text(), body);
  await grab.collectReviewVideos({ refresh: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].receiver, win);
  assert.equal(calls[0].args[1], options);
  assert.deepEqual(Array.from(grab.videos, row => row.url), [reviewVideo]);
  assert.equal(grab.reviewCollection.pendingResponses, 0);
  grab.stopWatching();
  assert.equal(win.fetch, original);
});

test('initial automatic collection re-reads only an observed Coupang review list GET', async () => {
  const page = 'https://www.coupang.com/vp/products/123?vendorItemId=456';
  const endpoint = 'https://www.coupang.com/vp/product/reviews?productId=123&page=1';
  const f = reviewFixture({ documentURL: page, baseURI: page, resources: [{ name: endpoint, initiatorType: 'xmlhttprequest' }] });
  const calls = [];
  f.doc.defaultView.fetch = async (href, options) => {
    calls.push({ href, options });
    return new Response(`<div data-src=&quot;${reviewVideo.replaceAll('&', '&amp;')}&quot;></div>`,
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  };
  const grab = f.run();
  await grab.ready;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].href, endpoint);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.deepEqual(Array.from(grab.videos, row => row.url), [reviewVideo]);
  assert.equal(grab.pendingVideos.length, 0);
  assert.equal(grab.reviewCollection.refreshing, false);
  grab.stopWatching();
});

test('unknown request methods, cross-origin and action endpoints are never replayed', async () => {
  const f = reviewFixture({ resources: [
    { name: url('/api/reviews'), initiatorType: 'fetch' },
    { name: 'https://other.example/api/reviews', initiatorType: 'fetch' },
    { name: url('/api/reviews/delete'), initiatorType: 'fetch' }
  ] });
  const calls = [];
  f.doc.defaultView.fetch = (...args) => { calls.push(args); return Promise.resolve(new Response('{}', { headers: { 'Content-Type': 'application/json' } })); };
  const grab = f.run(); await grab.ready;
  await grab.collectReviewVideos();
  assert.equal(calls.length, 0);
  await f.doc.defaultView.fetch('/api/reviews', { method: 'POST', body: 'original request' });
  await grab.collectReviewVideos();
  assert.equal(calls.length, 1);
  assert.equal(grab.pendingVideos.length, 1);
  assert.equal(grab.videos.length, 0);
  grab.stopWatching();
});

test('manual refresh uses the exact observed GET URL and skips it once an original is found', async () => {
  const f = reviewFixture(), win = f.doc.defaultView, calls = [];
  let body = '{}';
  win.fetch = async (href, options) => { calls.push({ href, options }); return new Response(body, { headers: { 'Content-Type': 'application/json' } }); };
  const grab = f.run(); await grab.ready;
  const endpoint = '/api/reviews/list?productId=1&filter=video';
  await win.fetch(endpoint, { method: 'GET' });
  body = JSON.stringify({ videoUrl: reviewVideo });
  await grab.collectReviewVideos();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].href, url(endpoint));
  assert.deepEqual(Array.from(grab.videos, row => row.url), [reviewVideo]);
  await grab.collectReviewVideos();
  assert.equal(calls.length, 2);
  grab.stopWatching();
});

test('accessor and inherited POST methods are not read again or mistaken for replayable GET requests', async () => {
  const f = reviewFixture(), win = f.doc.defaultView, methods = [];
  let getterReads = 0;
  win.fetch = async (href, options) => {
    methods.push(options.method);
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  };
  const grab = f.run(); await grab.ready;
  const accessor = { get method() { getterReads++; return 'POST'; } };
  for (const options of [accessor, Object.create({ method: 'POST' })]) {
    await win.fetch('/api/reviews', options);
    await grab.collectReviewVideos();
  }
  assert.deepEqual(methods, ['POST', 'POST']);
  assert.equal(getterReads, 1);
  assert.equal(grab.reviewCollection.observedLists, 0);
  grab.stopWatching();
});

test('failed review list refresh is reported while the JPEG and unresolved review remain intact', async () => {
  const page = 'https://www.coupang.com/vp/products/123';
  const endpoint = 'https://www.coupang.com/vp/product/reviews?productId=123';
  const f = reviewFixture({ documentURL: page, baseURI: page, resources: [{ name: endpoint, initiatorType: 'fetch' }] });
  f.doc.defaultView.fetch = async () => new Response('denied', { status: 403, headers: { 'Content-Type': 'text/html' } });
  const grab = f.run(); await grab.ready;
  assert.equal(grab.videos.length, 0);
  assert.equal(grab.pendingVideos.length, 1);
  assert.equal(grab.reviewCollection.errors[0].url, endpoint);
  assert.match(grab.reviewCollection.errors[0].message, /403/);
  assert.ok(grab.getManifest().items.some(row => row.url === reviewThumb && row.type === 'IMAGE'));
  grab.stopWatching();
});

test('oversized streamed review responses stop metadata collection without consuming the page body', async () => {
  const f = reviewFixture(), win = f.doc.defaultView;
  const body = ' '.repeat(2 * 1024 ** 2 + 1) + JSON.stringify({ videoUrl: reviewVideo });
  const response = new Response(body, { headers: { 'Content-Type': 'application/json' } });
  win.fetch = () => Promise.resolve(response);
  const grab = f.run();
  await win.fetch('/api/reviews');
  const consumed = response.text();
  await grab.collectReviewVideos({ refresh: false });
  assert.equal(await consumed, body);
  assert.equal(grab.videos.length, 0);
  assert.ok(grab.reviewCollection.limitsReached.includes('review.fetch'));
  grab.stopWatching();
});

function installXHR(win) {
  win.XMLHttpRequest = class {
    constructor() { this.listeners = new Map(); this.responseType = ''; this.status = 200; }
    open(method, href) { this.method = method; this.href = href; return 'open result'; }
    send(body) { this.body = body; return 'send result'; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    removeEventListener(name, callback) { if (this.listeners.get(name) === callback) this.listeners.delete(name); }
    finish() { this.listeners.get('loadend')?.(); }
  };
  return { open: win.XMLHttpRequest.prototype.open, send: win.XMLHttpRequest.prototype.send };
}

test('XHR review JSON and text responses are read without changing request arguments or playback', () => {
  const f = reviewFixture(), win = f.doc.defaultView, original = installXHR(win);
  const grab = f.run(), first = new win.XMLHttpRequest();
  first.responseType = 'json'; first.response = { videoUrl: reviewVideo };
  assert.equal(first.open('GET', '/api/reviews'), 'open result');
  assert.equal(first.send(null), 'send result');
  assert.equal(first.body, null);
  first.finish();
  const second = new win.XMLHttpRequest();
  second.responseText = JSON.stringify({ videoUrl: reviewRoot + 'transcode/source.webm' });
  second.open('POST', '/api/reviews'); second.send('unmodified body'); second.finish();
  assert.equal(second.body, 'unmodified body');
  assert.equal(grab.videos.length, 2);
  assert.equal(grab.pendingVideos.length, 0);
  assert.equal(first.listeners.size, 0);
  grab.stopWatching();
  assert.equal(win.XMLHttpRequest.prototype.open, original.open);
  assert.equal(win.XMLHttpRequest.prototype.send, original.send);
});

test('stopping observation ignores late responses and preserves other subsequently installed fetch wrappers', async () => {
  const f = reviewFixture(), win = f.doc.defaultView;
  let resolveResponse;
  win.fetch = () => new Promise(resolve => { resolveResponse = resolve; });
  const grab = f.run();
  const response = win.fetch('/api/reviews');
  const nextWrapper = () => 'next wrapper'; win.fetch = nextWrapper;
  grab.stopWatching();
  resolveResponse(new Response(JSON.stringify({ videoUrl: reviewVideo }), { headers: { 'Content-Type': 'application/json' } }));
  await response; await grab.collectReviewVideos({ refresh: false });
  assert.equal(win.fetch, nextWrapper);
  assert.equal(grab.videos.length, 0);
});

test('unfinished page requests have a bounded wait and remain explicitly pending', async () => {
  const f = reviewFixture(), win = f.doc.defaultView;
  let resolveResponse, deadline;
  win.fetch = () => new Promise(resolve => { resolveResponse = resolve; });
  const grab = f.run(); await grab.ready;
  const original = win.fetch('/api/reviews');
  win.setTimeout = callback => { deadline = callback; return 1; };
  win.clearTimeout = () => {};
  const collecting = grab.collectReviewVideos({ refresh: false });
  deadline();
  const result = await collecting;
  assert.equal(result.pendingResponses, 1);
  assert.equal(result.pendingVideos.length, 1);
  resolveResponse(new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
  await original;
  grab.stopWatching();
});

test('real HTTP review JSON is captured before the page consumes it without requesting a video', async () => {
  const http = require('node:http'), requests = [];
  const body = JSON.stringify({ reviews: [{ videoUrl: reviewVideo, thumbnailUrl: reviewThumb }] });
  const server = http.createServer((request, response) => {
    requests.push([request.method, request.url]);
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let grab;
  try {
    const f = reviewFixture({ documentURL: origin + '/product', baseURI: origin + '/product' });
    f.doc.defaultView.fetch = fetch;
    grab = f.run(); await grab.ready;
    const request = new Request(origin + '/api/reviews?productId=1');
    const response = await f.doc.defaultView.fetch(request);
    assert.deepEqual(await response.json(), JSON.parse(body));
    await grab.collectReviewVideos({ refresh: false });
    assert.deepEqual(Array.from(grab.videos, row => row.url), [reviewVideo]);
    assert.equal(grab.pendingVideos.length, 0);
    assert.deepEqual(requests, [['GET', '/api/reviews?productId=1']]);
  } finally {
    grab?.stopWatching(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('YouTube iframe is collected with a video ID even when its document is cross-origin', () => {
  const f = fixture();
  const embed = 'https://www.youtube.com/embed/M7lc1UVf-VE?rel=0&autoplay=0';
  const frame = f.element('iframe', { attrs: { src: embed }, rect: { top: 350, left: 40 } });
  Object.defineProperty(frame, 'contentDocument', { get() { throw new Error('cross origin'); } });
  f.doc.body.append(frame);
  const grab = f.run(), row = grab.embeds[0];
  assert.equal(grab.embeds.length, 1);
  assert.deepEqual([row.type, row.provider, row.videoId, row.url, row.embedUrl, row.top, row.visible],
    ['EMBED', 'youtube', 'M7lc1UVf-VE', 'https://www.youtube.com/watch?v=M7lc1UVf-VE', embed, 350, true]);
  assert.deepEqual(Array.from(grab.blockedFrames), [embed]);
});

test('YouTube lazy and no-cookie embeds deduplicate by video ID and reject lookalike hosts', () => {
  const f = fixture();
  f.doc.body.append(
    f.element('iframe', { attrs: { 'data-src': 'https://www.youtube-nocookie.com/embed/M7lc1UVf-VE' }, rect: { top: 200 } }),
    f.element('iframe', { attrs: { src: 'https://www.youtube.com/embed/M7lc1UVf-VE?start=5' }, rect: { top: 100 } }),
    f.element('iframe', { attrs: { src: 'https://youtube.com.evil.example/embed/M7lc1UVf-VE' } }),
    f.element('iframe', { attrs: { src: 'https://www.youtube.com/embed/videoseries?list=anything' } }));
  const grab = f.run();
  assert.equal(grab.embeds.length, 1);
  assert.equal(grab.embeds[0].top, 100);
  assert.equal(grab.embeds[0].visible, true);
});

test('review thumbnails remain JPEGs and unresolved videos are reported without guessed URLs', () => {
  const f = fixture();
  const key = 'https://video.coupangcdn.com/cloud/PRODUCTREVIEW/202607/29/review-id/video-id/';
  const thumbnail = key + 'transcode/origin_thumbnail.0000002.jpg';
  f.doc.body.append(f.img(thumbnail, 900));
  const grab = f.run();
  assert.equal(grab.rows[0].type, 'IMAGE');
  assert.equal(grab.videos.length, 0);
  assert.equal(grab.pendingVideos.length, 1);
  assert.equal(grab.getManifest().pendingVideos[0].thumbnailUrl, thumbnail);
  f.doc.body.append(f.element('video', { attrs: { src: key + 'transcode/actual-720.mp4?signature=full' } }));
  grab.scan();
  assert.equal(grab.pendingVideos.length, 0);
  assert.equal(grab.videos.length, 1);
  assert.ok(grab.rows.some(row => row.url === thumbnail && row.type === 'IMAGE'));
});

test('automatic media event watcher retains the source after a review popup is removed', () => {
  const f = watchFixture(), native = f.element('video', { currentSrc: 'blob:https://shop.example/review' });
  const wrapper = f.element('video-js');
  let source = null;
  wrapper.player = { currentSource: () => source };
  wrapper.append(native); f.doc.body.append(wrapper);
  const grab = f.run();
  assert.equal(grab.watching, true);
  source = { src: '/late-review.m3u8?signature=complete&expires=999', type: 'application/vnd.apple.mpegurl' };
  f.listeners.get('loadedmetadata')({ target: wrapper });
  f.doc.body.children = [];
  grab.scan({ quiet: true });
  const row = grab.videos.find(row => row.url.includes('late-review.m3u8'));
  assert.equal(row.type, 'STREAM');
  assert.equal(row.url, url(source.src));
  assert.equal(row.visible, false);
});

test('MutationObserver captures a video in removedNodes before a later scan loses the popup', () => {
  const f = watchFixture(), grab = f.run();
  const video = f.element('video', { attrs: { src: '/short-lived.mp4?token=full' } });
  video.isConnected = false;
  f.mutations[0].callback([{ target: f.doc.body, addedNodes: [], removedNodes: [video] }]);
  assert.ok(grab.videos.some(row => row.url === url('/short-lived.mp4?token=full')));
});

test('resource watcher retains a late playlist even when resource timing no longer has it', () => {
  const f = watchFixture(), grab = f.run();
  f.resources[0].callback({ getEntries: () => [
    { name: url('/review.m3u8?token=whole'), initiatorType: 'fetch' },
    { name: 'https://mercury.coupang.com/e.gif?t=watch', initiatorType: 'fetch' },
    { name: 'https://www.youtube.com/embed/M7lc1UVf-VE', initiatorType: 'iframe' }
  ] });
  grab.scan({ quiet: true });
  assert.equal(grab.videos.length, 2);
  assert.equal(grab.excludedRows.length, 1);
  assert.equal(grab.embeds.length, 1);
  assert.equal(f.resources[0].options.buffered, true);
});

test('polling catches player API changes and rerunning the snippet disconnects previous watchers', () => {
  const f = watchFixture(), wrapper = f.element('video-js');
  let source = null;
  wrapper.player = { currentSource: () => source };
  f.doc.body.append(wrapper);
  const first = f.run();
  source = { src: '/poll-review.mp4', type: 'video/mp4' };
  f.intervals.values().next().value();
  assert.equal(first.videos.length, 1);
  const second = f.run();
  assert.equal(first.watching, false);
  assert.equal(second.watching, true);
  assert.equal(f.intervals.size, 1);
  assert.equal(f.mutations[0].disconnected, true);
  assert.equal(f.resources[0].disconnected, true);
  second.stopWatching();
  assert.equal(f.intervals.size, 0);
  assert.equal(f.listeners.size, 0);
});

test('page top/left overrides both DOM order and network order; unplaced addresses follow', () => {
  const f = fixture({ resources: ['bottom.jpg', 'orphan.webp', 'right.jpg', 'left.jpg']
    .map(name => ({ name: url(name), initiatorType: 'img' })) });
  f.doc.body.append(f.img('bottom.jpg', 700), f.img('right.jpg', 100, 200),
    f.img('left.jpg', 100, 20), f.element('a', { attrs: { href: 'linked.gif' } }));
  const grab = f.run();
  assert.deepEqual(urls(grab), ['left.jpg', 'right.jpg', 'bottom.jpg', 'orphan.webp', 'linked.gif'].map(url));
  assert.deepEqual(Array.from(grab.rows, row => row.order), [1, 2, 3, 4, 5]);
  assert.equal(grab.rows[3].top, null);
  assert.deepEqual(visible(grab), ['left.jpg', 'right.jpg', 'bottom.jpg'].map(url));
});

test('700 distinct images retain all URLs and follow page positions', () => {
  const names = Array.from({ length: 700 }, (_, i) => `item-${i}.jpg`);
  const f = fixture({ resources: [...names].reverse().map(name => ({ name: url(name), initiatorType: 'img' })) });
  for (let i = names.length - 1; i >= 0; i--) f.doc.body.append(f.img(names[i], Math.floor(i / 10) * 180, i % 10 * 130));
  const grab = f.run();
  assert.equal(grab.rows.length, 700);
  assert.deepEqual(urls(grab), names.map(url));
  assert.deepEqual(visible(grab), names.map(url));
});

test('src/srcset/lazy alternatives remain collected, while selected picture URL is visible', () => {
  const f = fixture();
  const picture = f.element('picture');
  picture.append(f.element('source', { attrs: { srcset: 'wide.avif 1200w' } }),
    f.img('small.jpg', 250, 30, { currentSrc: url('selected.jpg'),
      attrs: { srcset: 'small.jpg 1x, selected.jpg 2x', 'data-original': 'original.jpg' } }));
  f.doc.body.append(picture);
  const grab = f.run();
  assert.deepEqual(visible(grab), [url('selected.jpg')]);
  assert.deepEqual(new Set(urls(grab)), new Set(['small.jpg', 'selected.jpg', 'original.jpg', 'wide.avif'].map(url)));
  for (const row of grab.rows) assert.deepEqual([row.top, row.left], [250, 30]);
  assert.equal(grab.rows[0].url, url('selected.jpg'));
});

test('duplicate URLs use the first rendered occurrence, never a hidden clone', () => {
  const f = fixture({ resources: [{ name: url('same.gif'), initiatorType: 'img' }] });
  const hidden = f.element('div', { styles: { opacity: '0' } });
  hidden.append(f.img('hidden-only.jpg', 1));
  f.doc.body.append(f.img('same.gif', 0, 0, { styles: { display: 'none' } }),
    f.img('same.gif', 30, 10), f.img('same.gif', 15, 40), hidden);
  const grab = f.run();
  assert.equal(grab.rows.length, 2);
  assert.deepEqual([grab.rows[0].top, grab.rows[0].left], [15, 40]);
  assert.equal(grab.rows[0].type, 'GIF');
  assert.deepEqual(visible(grab), [url('same.gif')]);
  assert.equal(grab.rows[1].top, null);
});

test('scan refreshes moved/hidden/removed elements, keeping historical URLs at the end', () => {
  const f = fixture();
  const a = f.img('a.jpg', 10), b = f.img('b.jpg', 20), c = f.img('c.jpg', 30);
  f.doc.body.append(a, b, c);
  const grab = f.run();
  a.rect.top = 900;
  b.styles.display = 'none';
  f.doc.body.children.splice(2, 1);
  f.doc.body.append(f.img('d.jpg', 5));
  grab.scan();
  assert.deepEqual(urls(grab), ['d.jpg', 'a.jpg', 'b.jpg', 'c.jpg'].map(url));
  assert.deepEqual(visible(grab), ['d.jpg', 'a.jpg'].map(url));
  assert.equal(grab.rows[1].top, 900);
  assert.equal(grab.rows[3].top, null);
  assert.ok(!urls(f.run()).includes(url('c.jpg')));
});

test('ordinary document coordinates stay stable after horizontal and vertical scroll', () => {
  const f = fixture({ scrollX: 50, scrollY: 600 });
  f.doc.body.append(f.img('below.jpg', 1800, 90), f.img('above.jpg', 100, 20));
  const grab = f.run();
  assert.deepEqual(Array.from(grab.rows, row => [row.top, row.left]), [[100, 20], [1800, 90]]);
  assert.equal(grab.visibleUrls.length, 2);
  f.doc.defaultView.scrollY = 0;
  f.doc.defaultView.scrollX = 0;
  grab.scan();
  assert.deepEqual(Array.from(grab.rows, row => [row.top, row.left]), [[100, 20], [1800, 90]]);
});

test('CSS, pseudo images, GIF, video and poster receive their host positions', () => {
  const f = fixture();
  const tile = f.element('div', {
    rect: { top: 200, left: 40 }, attrs: { 'data-bg': '/pending.jpg' },
    styles: { 'background-image': 'url("/background.webp")' },
    pseudos: { '::before': { content: 'url("/mark.gif")' },
      '::after': { content: 'none', 'background-image': 'url("/inactive.jpg")' } }
  });
  f.doc.body.append(tile, f.element('video', {
    rect: { top: 50, left: 80 }, attrs: { src: '/clip.mp4', poster: '/poster.jpg' }
  }));
  const grab = f.run();
  assert.deepEqual(visible(grab), ['/clip.mp4', '/poster.jpg', '/background.webp', '/mark.gif'].map(url));
  assert.equal(grab.rows.find(row => row.url === url('/clip.mp4')).type, 'VIDEO');
  assert.equal(grab.rows.find(row => row.url === url('/mark.gif')).type, 'GIF');
  const pending = grab.rows.find(row => row.url === url('/pending.jpg'));
  assert.equal(pending.source, 'data-bg');
  assert.deepEqual([pending.top, pending.left, pending.visible], [200, 40, false]);
  assert.equal(grab.rows.find(row => row.url === url('/inactive.jpg')).visible, false);
});

test('Video.js wrapper exposes the original signed source behind a native blob URL', () => {
  const f = fixture();
  const blob = 'blob:https://shop.example/review-player';
  const current = { src: '/review/master.m3u8?signature=' + 'x'.repeat(400) + '&expires=123', type: 'application/x-mpegURL' };
  const alternative = { src: '/review/alternate.mp4', type: 'video/mp4' };
  const wrapper = f.element('div', { attrs: { id: 'vjs_video_1', class: 'video-js vjs-v7' } });
  const video = f.element('video', { attrs: { src: blob }, rect: { top: 350, left: 70 } });
  const player = {
    currentSource() { assert.equal(this, player); return current; },
    currentSources() { return [current, alternative]; }
  };
  wrapper.player = player;
  wrapper.append(video);
  f.doc.body.append(wrapper);
  const grab = f.run();
  const row = grab.rows.find(r => r.url === url(current.src));
  assert.deepEqual([row.type, row.source, row.top, row.left, row.visible, row.temporary],
    ['STREAM', 'videojs.currentSource', 350, 70, true, false]);
  assert.equal(grab.rows.find(r => r.url === blob).temporary, true);
  assert.equal(grab.rows.find(r => r.url === url(alternative.src)).visible, false);
  assert.equal(grab.rows.filter(r => r.url === url(current.src)).length, 1);
  assert.ok(grab.getManifest({ visibleOnly: true }).items.some(r => r.url === url(current.src)));
});

test('Video.js getPlayer reads an existing player without initializing or changing playback', () => {
  const f = fixture();
  const video = f.element('video', { currentSrc: 'blob:https://shop.example/playing' });
  let lookups = 0;
  const player = {
    currentSrc() { return '/review/play?id=123&signature=full-value'; },
    currentType() { return 'video/mp4'; },
    src() { assert.fail('must not set or retrieve sources through src()'); },
    play() { assert.fail('must not start playback'); }
  };
  const videojs = () => assert.fail('must not initialize a player');
  videojs.getPlayer = element => { lookups++; assert.equal(element, video); return player; };
  f.doc.defaultView.videojs = videojs;
  f.doc.defaultView.fetch = () => assert.fail('must not request a source');
  f.doc.body.append(video);
  const grab = f.run();
  const row = grab.rows.find(r => r.url === url('/review/play?id=123&signature=full-value'));
  assert.deepEqual([row.type, row.source, row.visible], ['VIDEO', 'videojs.currentSrc', true]);
  assert.equal(lookups, 1);
});

test('Video.js MIME types identify extensionless HLS and DASH sources', () => {
  const f = fixture();
  for (const [name, mime] of [['hls', 'application/vnd.apple.mpegurl; charset=UTF-8'], ['dash', 'application/dash+xml']]) {
    const host = f.element('video-js', { rect: { top: name === 'hls' ? 200 : 300 } });
    host.player = { currentSource: () => ({ src: '/stream/' + name + '?signed=full', type: mime }) };
    f.doc.body.append(host);
  }
  const grab = f.run();
  assert.deepEqual(Array.from(grab.rows, r => [r.type, r.visible]), [['STREAM', true], ['STREAM', true]]);
});

test('unavailable player getters preserve native media and other source getters', () => {
  const f = fixture();
  const unavailable = f.element('video', { attrs: { src: '/native.mp4' } });
  Object.defineProperty(unavailable, 'player', { get() { throw new Error('not available'); } });
  f.doc.defaultView.videojs = { getPlayer() { throw new Error('not available'); } };
  const remaining = f.element('video');
  remaining.player = {
    currentSource() { throw new Error('disposed getter'); },
    currentSources() { return [{ src: '/still-readable.mp4' }, null, { src: 123 }, 'javascript:alert(1)']; }
  };
  f.doc.body.append(unavailable, remaining, f.img('/normal.jpg', 500));
  const grab = f.run();
  assert.deepEqual(new Set(urls(grab)), new Set(['/native.mp4', '/still-readable.mp4', '/normal.jpg'].map(url)));
});

test('rescan captures late player sources and preserves them after the review popup closes', () => {
  const f = fixture();
  const popup = f.element('div', { attrs: { class: 'video-js' } });
  const video = f.element('video', { attrs: { src: 'blob:https://shop.example/first' } });
  let current = {};
  popup.player = { currentSource: () => current };
  popup.append(video);
  f.doc.body.append(popup);
  const grab = f.run();
  assert.equal(grab.rows.filter(r => !r.temporary).length, 0);
  current = { src: '/review/original.m3u8?token=unshortened', type: 'application/x-mpegURL' };
  video.currentSrc = 'blob:https://shop.example/reopened';
  video.attrs.src = video.currentSrc;
  grab.scan();
  assert.equal(grab.rows.find(r => r.url === url(current.src)).source, 'videojs.currentSource');
  f.doc.body.children = f.doc.body.children.filter(el => el !== popup);
  grab.scan();
  const row = grab.getManifest().items.find(r => r.url === url(current.src));
  assert.equal(row.type, 'STREAM');
  assert.equal(row.top, null);
});

test('automatic capture preserves both Amazon video-card lists after they close without scanning or playback', () => {
  const f = watchFixture({ documentURL: 'https://www.amazon.com/dp/TEST', baseURI: 'https://www.amazon.com/dp/TEST' });
  f.doc.defaultView.fetch = () => assert.fail('card metadata must not make requests');
  const grab = f.run();
  const expected = new Map();
  for (const [sectionId, playlist, offset] of [
    ['ivVideoBlock', 'product-videos', 0], ['vftphero-vse-related-videos', 'related-videos', 10]
  ]) {
    const section = f.element('div', { attrs: { id: sectionId } });
    for (let i = 0; i < 10; i++) {
      const id = offset + i;
      const href = `https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-us-east-1-prod/video-${id}/default.jobtemplate.hls.m3u8?signature=whole%2Fvalue&expires=999`;
      const title = `Amazon video ${id}`;
      const card = f.element('div', { attrs: { 'data-element-id': 'video-carousel-item',
        'data-video-url': href, 'data-title': title, 'data-aci-content-id': `amzn1.vse.video.id-${id}` },
        rect: { top: 100 + i * 90, left: 200 } });
      card.closest = selector => selector.includes('#' + sectionId) ? section : null;
      section.append(card);
      expected.set(href, { title, playlist, videoId: `amzn1.vse.video.id-${id}` });
    }
    f.doc.body.append(section);
    f.mutations[0].callback([{ type: 'childList', target: f.doc.body, addedNodes: [section], removedNodes: [] }]);
    assert.equal(grab.videos.length, offset + 10);
    f.doc.body.children = f.doc.body.children.filter(el => el !== section);
    section.isConnected = false;
    for (const card of section.children) card.isConnected = false;
    f.mutations[0].callback([{ type: 'childList', target: f.doc.body, addedNodes: [], removedNodes: [section] }]);
  }
  assert.equal(grab.videos.length, 20);
  const manifest = grab.getManifest();
  assert.equal(manifest.items.length, 20);
  for (const row of manifest.items) {
    const item = expected.get(row.url);
    assert.ok(item, row.url);
    assert.equal(row.type, 'STREAM');
    assert.equal(row.provider, 'amazon');
    assert.equal(row.videoTitle, item.title);
    assert.equal(row.videoId, item.videoId);
    assert.deepEqual(Array.from(row.playlists), [item.playlist]);
    assert.equal(row.top, null);
  }
  grab.stopWatching();
});

test('Amazon video cards refresh their URL and identity on attribute changes and retain playlist provenance', () => {
  const f = watchFixture({ documentURL: 'https://www.amazon.com/dp/TEST' });
  const first = 'https://m.media-amazon.com/first.m3u8?token=original';
  const second = 'https://m.media-amazon.com/second.mp4?token=next';
  const section = f.element('div', { attrs: { id: 'ivVideoBlock' } });
  const card = f.element('div', { attrs: { 'data-element-id': 'video-carousel-item',
    'data-video-url': first, 'data-title': 'First video', 'data-aci-content-id': 'amzn1.vse.video.first' } });
  card.closest = selector => selector.split(',').some(part => part.trim() === '#' + section.attrs.id) ? section : null;
  section.append(card); f.doc.body.append(section);
  const grab = f.run();
  card.attrs['data-video-url'] = second;
  card.attrs['data-title'] = 'Second video';
  card.attrs['data-aci-content-id'] = 'amzn1.vse.video.second';
  f.mutations[0].callback([{ type: 'attributes', target: card, attributeName: 'data-video-url' }]);
  assert.deepEqual(new Set(grab.urls), new Set([first, second]));
  const changed = grab.rows.find(row => row.url === second);
  assert.equal(changed.type, 'VIDEO');
  assert.equal(changed.videoTitle, 'Second video');
  assert.equal(changed.videoId, 'amzn1.vse.video.second');
  section.attrs.id = 'vftphero-vse-related-videos';
  for (const callback of f.intervals.values()) callback();
  assert.deepEqual(new Set(grab.rows.find(row => row.url === second).playlists),
    new Set(['product-videos', 'related-videos']));
  grab.stopWatching();
});

const amazonThumbIds = ['5103zNzqjuL', '81gZcQ0ihiL', '91m+kKuq1pL', '61Sel6JZ7LL', '61t0iMgg-gL', '51gB21-+2DL',
  '61A+pxCA72L', '61ycSX5iWkL', '71Mj9ka0vqL', '51Ixi9aekPL', '71xH9-kBzLL', '410-fH9zd8L', '512lOchV77L',
  '61+yUWlXcYL', '71XeH07-jzL', '51XyDzv8h0L', '61I4BWllVBL', '61fpgZtjymL'];
const amazonThumb = (id, variant = 'SR342,193') => 'https://m.media-amazon.com/images/I/' + id + '._' + variant + '_.jpg';
function amazonFixture() {
  const f = watchFixture({ documentURL: 'https://www.amazon.com/dp/TEST', baseURI: 'https://www.amazon.com/dp/TEST' });
  Object.assign(f.doc.defaultView, { AbortController, Request, setTimeout, clearTimeout });
  f.context.TextDecoder = TextDecoder;
  return f;
}
// These are declared test records, not recovered URLs for the user's missing
// videos. The thumbnail identities come from the user's HTML; video URLs are
// explicitly synthetic so a mocked success cannot be mistaken for a live test.
const amazonRecord = (i, extra = {}) => ({
  videoId: 'amzn1.vse.video.fixture-' + i, title: 'Fixture video ' + i,
  thumbnailUrl: amazonThumb(amazonThumbIds[i]),
  sources: [{ src: 'https://cdn.example/fixture-' + i + '.m3u8?signature=whole%2Bvalue&literal=a&amp;b',
    type: 'application/vnd.apple.mpegurl' }], ...extra
});

test('Amazon a-state JSON captures the full declared list beyond rendered cards and links thumbnail variants', async () => {
  const f = amazonFixture(), win = f.doc.defaultView;
  win.fetch = () => assert.fail('initial metadata must not trigger network requests');
  const records = amazonThumbIds.map((_, i) => amazonRecord(i));
  for (let i = 0; i < 10; i++) f.doc.body.append(f.img(amazonThumb(amazonThumbIds[i], 'SX180'), 100 + i * 90,
    20, { attrs: { alt: 'video thumbnail' } }));
  const script = f.element('script', { attrs: { type: 'a-state', 'data-a-state': '{"key":"fixture-video-list"}' } });
  script.textContent = JSON.stringify({ title: 'Gallery', imageUrl: amazonThumb('NotAVideo'), videos: records }).replaceAll('/', '\\/');
  f.doc.body.append(script);
  const grab = f.run(); await grab.ready;
  assert.equal(grab.videos.length, 18);
  assert.equal(grab.pendingVideos.length, 0);
  assert.equal(grab.amazonCollection.thumbnailsObserved, 18);
  assert.equal(grab.amazonCollection.thumbnailsWithOriginal, 18);
  for (const row of grab.videos) {
    const record = records.find(r => r.videoId === row.videoId);
    assert.ok(record);
    assert.equal(row.url, record.sources[0].src);
    assert.equal(row.thumbnailUrl, record.thumbnailUrl);
    assert.equal(row.videoTitle, record.title);
    assert.equal(row.provider, 'amazon');
    assert.equal(row.source, 'amazon.script');
  }
  assert.ok(!grab.urls.includes(amazonThumb('NotAVideo')));
  assert.ok(grab.videos.find(row => row.videoId === records[0].videoId).top !== null);
  assert.equal(grab.videos.find(row => row.videoId === records[17].videoId).top, null);
  grab.stopWatching();
});

test('Amazon thumbnail-only entries stay pending and an unrelated video never resolves them', () => {
  const f = amazonFixture();
  const section = f.element('div', { attrs: { id: 'vftphero-vse-related-videos' } });
  for (const variant of ['SX180', 'SR342,193']) section.append(f.img(amazonThumb(amazonThumbIds[0], variant), 100));
  f.doc.body.append(section);
  const grab = f.run();
  assert.equal(grab.videos.length, 0);
  assert.equal(grab.pendingVideos.length, 1);
  assert.equal(grab.pendingVideos[0].provider, 'amazon');
  const script = f.element('script', { attrs: { type: 'application/json' } });
  script.textContent = JSON.stringify(amazonRecord(1));
  f.doc.body.append(script);
  f.mutations[0].callback([{ type: 'childList', target: f.doc.body, addedNodes: [script] }]);
  assert.equal(grab.videos.length, 1);
  assert.equal(grab.pendingVideos.length, 1);
  assert.equal(grab.pendingVideos[0].thumbnailUrl, amazonThumb(amazonThumbIds[0], 'SX180'));
  script.textContent = JSON.stringify(amazonRecord(0));
  f.mutations[0].callback([{ type: 'characterData', target: { parentElement: script } }]);
  assert.equal(grab.pendingVideos.length, 0);
  assert.equal(grab.videos.length, 2, 'the earlier source must remain after state replacement');
  grab.stopWatching();
});

test('Amazon hydration metadata retains page coordinates when the rendered thumbnail uses a different crop', () => {
  const f = amazonFixture(), record = amazonRecord(0);
  f.doc.defaultView.__INITIAL_STATE__ = { videos: [record] };
  f.doc.body.append(f.img(amazonThumb(amazonThumbIds[0], 'SX180'), 700, 40, { attrs: { alt: 'video thumbnail' } }));
  const grab = f.run();
  assert.equal(grab.videos.length, 1);
  assert.equal(grab.videos[0].top, 700);
  assert.equal(grab.videos[0].left, 40);
  assert.equal(grab.pendingVideos.length, 0);
  grab.stopWatching();
});

test('Amazon original URLs on a card resolve only that card thumbnail', () => {
  const f = amazonFixture(), record = amazonRecord(0);
  const card = f.element('div', { attrs: { class: 'vse-video-card', 'data-video-url': record.sources[0].src,
    'data-title': record.title, 'data-aci-content-id': record.videoId } });
  card.append(f.img(record.thumbnailUrl, 100));
  f.doc.body.append(card, f.img(amazonThumb(amazonThumbIds[1]), 200, 0, { attrs: { alt: 'video thumbnail' } }));
  const grab = f.run();
  assert.equal(grab.videos.length, 1);
  assert.equal(grab.videos[0].thumbnailUrl, record.thumbnailUrl);
  assert.equal(grab.pendingVideos.length, 1);
  assert.equal(grab.pendingVideos[0].thumbnailUrl, amazonThumb(amazonThumbIds[1]));
  assert.equal(grab.getManifest().amazonCollection.pendingThumbnails, 1);
  grab.stopWatching();
});

test('Amazon JSON.parse strings and inline JSON objects are read without executing scripts or rewriting signatures', () => {
  const f = amazonFixture(), one = amazonRecord(0), two = amazonRecord(1);
  for (const text of [
    'window.fixtureRan = true; const list = JSON.parse(' + JSON.stringify(JSON.stringify({ videos: [one] })) + ');',
    'A.state("fixture-list", ' + JSON.stringify({ videos: [two] }) + '); window.fixtureRan = true;',
    '// "https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-test/comment/fake.mp4"\n' +
      '/* "https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-test/comment/fake.m3u8" */'
  ]) { const script = f.element('script'); script.textContent = text; f.doc.body.append(script); }
  const grab = f.run();
  assert.equal(f.doc.defaultView.fixtureRan, undefined);
  assert.deepEqual(new Set(Array.from(grab.videos, row => row.url)), new Set([one.sources[0].src, two.sources[0].src]));
  assert.equal(grab.pendingVideos.length, 0);
  assert.ok(grab.videos.every(row => row.url.endsWith('&literal=a&amp;b')));
  grab.stopWatching();
});

test('Amazon hydration and React records preserve sources while skipping getters, audio and segment URLs', () => {
  const f = amazonFixture(), win = f.doc.defaultView, record = amazonRecord(0);
  win.__INITIAL_STATE__ = { productVideos: [record], audio: { sources: [{ src: 'https://cdn.example/audio.mp4', type: 'audio/mp4' }] },
    videos: ['amzn1.vse.video.id-without-a-url', { videoUrl: 'https://cdn.example/segment.ts' }] };
  const image = f.img(amazonThumb(amazonThumbIds[1]), 300, 0, { attrs: { alt: 'video thumbnail' } });
  const props = { video: amazonRecord(1) }; props.cycle = props;
  Object.defineProperty(props, 'videoUrl', { get() { assert.fail('getter must not run'); } });
  Object.defineProperty(image, '__reactProps$fixture', { value: props });
  f.doc.body.append(image);
  const grab = f.run();
  assert.equal(grab.videos.length, 2);
  assert.deepEqual(new Set(Array.from(grab.videos, row => row.videoId)), new Set([record.videoId, amazonRecord(1).videoId]));
  assert.equal(grab.pendingVideos.length, 0);
  assert.ok(!grab.urls.some(href => /audio\.mp4|segment\.ts|id-without-a-url/.test(href)));
  grab.stopWatching();
});

test('Amazon observed POST video-list responses preserve the page body and are never replayed', async () => {
  const f = amazonFixture(), win = f.doc.defaultView, calls = [];
  const record = amazonRecord(0), response = new Response(JSON.stringify({ videos: [record] }),
    { headers: { 'Content-Type': 'application/json' } });
  const promise = Promise.resolve(response);
  win.fetch = (...args) => { calls.push(args); return promise; };
  f.doc.body.append(f.img(record.thumbnailUrl, 100, 0, { attrs: { alt: 'video thumbnail' } }));
  const grab = f.run(); await grab.ready;
  const result = win.fetch('/gp/video/list', { method: 'POST', body: 'fixture=unchanged' });
  assert.equal(result, promise);
  assert.equal(await result, response);
  assert.equal(JSON.parse(await response.text()).videos[0].videoId, record.videoId);
  await grab.collectVideos();
  assert.equal(calls.length, 1);
  assert.equal(grab.videos.length, 1);
  assert.equal(grab.videos[0].url, record.sources[0].src);
  assert.equal(grab.videos[0].source, 'amazon.fetch');
  assert.equal(grab.pendingVideos.length, 0);
  grab.stopWatching();
});

test('Amazon JSON attributes and late state remain captured after their DOM nodes close', () => {
  const f = amazonFixture(), record = amazonRecord(0);
  const node = f.element('div', { attrs: { 'data-video-data': JSON.stringify(record) } });
  f.doc.body.append(node);
  const grab = f.run();
  assert.equal(grab.videos.length, 1);
  node.attrs['data-video-data'] = JSON.stringify(amazonRecord(1));
  f.mutations[0].callback([{ type: 'attributes', target: node, attributeName: 'data-video-data' }]);
  f.doc.body.children = [];
  node.isConnected = false;
  f.mutations[0].callback([{ type: 'childList', target: f.doc.body, removedNodes: [node] }]);
  assert.equal(grab.getManifest().items.filter(row => row.type === 'STREAM').length, 2);
  assert.equal(grab.pendingVideos.length, 0);
  grab.stopWatching();
});

test('Amazon list HTTP errors remain visible without consuming the page body and clear after a real successful response', async () => {
  const f = amazonFixture(), win = f.doc.defaultView, record = amazonRecord(0);
  const responses = [new Response('fixture service unavailable', { status: 503 }),
    new Response(JSON.stringify({ videos: [record] }), { headers: { 'Content-Type': 'application/json' } })];
  let calls = 0;
  win.fetch = () => Promise.resolve(responses[calls++]);
  f.doc.body.append(f.img(record.thumbnailUrl, 100, 0, { attrs: { alt: 'video thumbnail' } }));
  const grab = f.run(); await grab.ready;
  const failed = await win.fetch('/gp/video/list', { method: 'POST' });
  assert.equal(await failed.text(), 'fixture service unavailable');
  await grab.collectVideos();
  assert.equal(calls, 1);
  assert.equal(grab.pendingVideos.length, 1);
  assert.match(grab.amazonCollection.errors[0].message, /503/);
  const success = await win.fetch('/gp/video/list', { method: 'POST' });
  assert.equal(JSON.parse(await success.text()).videos[0].videoId, record.videoId);
  await grab.collectVideos();
  assert.equal(calls, 2);
  assert.equal(grab.pendingVideos.length, 0);
  assert.equal(grab.amazonCollection.errors.length, 0);
  grab.stopWatching();
});

test('Amazon oversized state reports its limit instead of claiming video completeness', () => {
  const f = amazonFixture(), script = f.element('script', { attrs: { type: 'a-state' } });
  script.textContent = JSON.stringify({ videos: [amazonRecord(0)], padding: 'x'.repeat(2 * 1024 ** 2) });
  f.doc.body.append(script, f.img(amazonThumb(amazonThumbIds[0]), 100, 0, { attrs: { alt: 'video thumbnail' } }));
  const grab = f.run();
  assert.equal(grab.videos.length, 0);
  assert.equal(grab.pendingVideos.length, 1);
  assert.ok(grab.amazonCollection.limitsReached.length);
  grab.stopWatching();
});

test('the user thumbnail shapes identify 18 pending previews without inventing any of their video URLs', () => {
  const f = amazonFixture(), related = f.element('div', { attrs: { id: 'vftphero-vse-related-videos' } });
  for (let i = 0; i < 6; i++) f.doc.body.append(f.img(amazonThumb(amazonThumbIds[i]), 100 + i * 90, 0,
    { attrs: { alt: 'video thumbnail' } }));
  for (let i = 6; i < 10; i++) {
    const card = f.element('div', { attrs: { 'data-element-id': 'video-thumbnail' } });
    card.append(f.img(amazonThumb(amazonThumbIds[i]), 700 + i * 90, 0, { attrs: { alt: 'Review title ' + i } }));
    card.outerHTML = '<div data-element-id="video-thumbnail"><img src="' + amazonThumb(amazonThumbIds[i]) + '"></div>';
    f.doc.body.append(card);
  }
  for (const i of [10, 1, 11, 12, 13, 4, 14, 15, 16, 17]) related.append(f.img(amazonThumb(amazonThumbIds[i]), 1500 + i * 90));
  f.doc.body.append(related);
  const grab = f.run();
  assert.equal(grab.videos.length, 0);
  assert.equal(grab.pendingVideos.length, 18);
  assert.equal(grab.amazonCollection.thumbnailsObserved, 18);
  assert.equal(grab.amazonCollection.thumbnailsWithOriginal, 0);
  assert.ok(grab.pendingVideos.some(row => row.cardHtml?.includes('video-thumbnail')));
  assert.ok(grab.rows.every(row => row.type === 'IMAGE'));
  grab.stopWatching();
});

test('Amazon video JSON-LD retains the actual encoding URL and associates its thumbnail', () => {
  const f = amazonFixture(), record = amazonRecord(0);
  const script = f.element('script', { attrs: { type: 'application/ld+json' } });
  script.textContent = JSON.stringify({ '@type': 'VideoObject', name: record.title, thumbnailUrl: record.thumbnailUrl,
    encoding: { contentUrl: record.sources[0].src } });
  f.doc.body.append(script);
  const grab = f.run();
  assert.equal(grab.videos.length, 1);
  assert.equal(grab.videos[0].url, record.sources[0].src);
  assert.equal(grab.videos[0].videoTitle, record.title);
  assert.equal(grab.pendingVideos.length, 0);
  grab.stopWatching();
});

test('Amazon XHR JSON video lists are observed once and detached correctly', async () => {
  const f = amazonFixture(), win = f.doc.defaultView, record = amazonRecord(0);
  let sends = 0;
  win.XMLHttpRequest = class {
    constructor() { this.listeners = new Map(); this.responseType = 'json'; this.response = { videos: [record] }; }
    open(method, url) { this.method = method; this.responseURL = new URL(url, f.doc.URL).href; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    removeEventListener(name, callback) { if (this.listeners.get(name) === callback) this.listeners.delete(name); }
    send() { sends++; this.status = 200; this.listeners.get('loadend')?.(); }
  };
  const originalOpen = win.XMLHttpRequest.prototype.open, originalSend = win.XMLHttpRequest.prototype.send;
  const grab = f.run(), request = new win.XMLHttpRequest();
  request.open('POST', '/gp/video/list'); request.send();
  await grab.collectReviewVideos();
  assert.equal(sends, 1);
  assert.equal(request.response.videos[0], record);
  assert.equal(grab.videos.length, 1);
  assert.equal(grab.videos[0].source, 'amazon.xhr.json');
  grab.stopWatching();
  assert.equal(win.XMLHttpRequest.prototype.open, originalOpen);
  assert.equal(win.XMLHttpRequest.prototype.send, originalSend);
});

test('Amazon image metadata preserves actual original URLs and changing GIFs without rescanning', () => {
  const f = watchFixture({ documentURL: 'https://www.amazon.com/dp/TEST' });
  const original = 'https://m.media-amazon.com/images/I/original.jpg?signature=whole%2Fvalue&expires=999';
  const large = 'https://m.media-amazon.com/images/I/large.jpg';
  const animation = 'https://m.media-amazon.com/images/I/animation.gif';
  const image = f.img('/small.jpg', 200, 20, { attrs: { 'data-old-hires': original,
    'data-a-dynamic-image': JSON.stringify({ [large]: [1500, 1500], 'javascript:alert(1)': [1, 1] }) } });
  f.doc.body.append(image);
  const grab = f.run();
  assert.deepEqual(new Set(grab.urls), new Set([url('/small.jpg'), original, large]));
  image.currentSrc = animation;
  image.attrs.src = animation;
  f.mutations[0].callback([{ type: 'attributes', target: image, attributeName: 'src' }]);
  assert.equal(grab.rows.find(row => row.url === animation).type, 'GIF');
  const late = 'https://m.media-amazon.com/images/I/later-original.jpg';
  image.attrs['data-a-dynamic-image'] = JSON.stringify({ [late]: [2000, 2000] });
  f.mutations[0].callback([{ type: 'attributes', target: image, attributeName: 'data-a-dynamic-image' }]);
  assert.ok(grab.urls.includes(late));
  image.attrs['data-a-dynamic-image'] = '{malformed';
  image.attrs['data-old-hires'] = original;
  f.mutations[0].callback([{ type: 'attributes', target: image, attributeName: 'data-a-dynamic-image' }]);
  f.doc.body.children = [];
  image.isConnected = false;
  f.mutations[0].callback([{ type: 'childList', target: f.doc.body, addedNodes: [], removedNodes: [image] }]);
  const urls = new Set(grab.getManifest().items.map(row => row.url));
  for (const href of [original, large, animation, late]) assert.ok(urls.has(href), href);
  grab.stopWatching();
});

test('Video.js sources use iframe page coordinates and exclude audio players', () => {
  const f = fixture(), child = fixture();
  const video = child.element('video', { rect: { top: 20, left: 30 } });
  video.player = { currentSource: () => ({ src: '/child.mp4' }) };
  child.doc.body.append(video);
  const frame = f.element('iframe', { rect: { top: 500, left: 100, width: 300, height: 200 } });
  Object.assign(frame, { contentDocument: child.doc, offsetWidth: 300, offsetHeight: 200, clientWidth: 300, clientHeight: 200 });
  const audio = f.element('div', { attrs: { class: 'video-js vjs-audio' } });
  audio.player = { isAudio: () => true, currentSource: () => ({ src: '/audio-only.mp4' }) };
  f.doc.body.append(frame, audio);
  const grab = f.run();
  assert.deepEqual(Array.from(grab.rows, r => [r.url, r.top, r.left]), [[url('/child.mp4'), 520, 130]]);
});

test('open shadow DOM respects host clipping and host opacity', () => {
  const f = fixture();
  const host = f.element('div', { rect: { top: 20, left: 20, width: 100, height: 100 },
    styles: { overflowX: 'hidden', overflowY: 'hidden' } });
  f.shadow(host, f.img('shown.jpg', 30, 30), f.img('clipped.jpg', 200, 30));
  f.doc.body.append(host);
  const grab = f.run();
  assert.equal(grab.rows.length, 2);
  assert.deepEqual(visible(grab), [url('shown.jpg')]);
  assert.equal(grab.rows.find(row => row.url === url('clipped.jpg')).top, null);
  host.styles.opacity = '0';
  grab.scan();
  assert.equal(grab.visibleUrls.length, 0);
  assert.ok(grab.rows.every(row => row.top === null));
});

test('iframe child positions include parent offset, scale, border and child scroll', () => {
  const f = fixture({ scrollX: 10, scrollY: 100 }), child = fixture({ scrollY: 5 });
  child.doc.body.append(child.img('inside.jpg', 30, 20), child.img('outside.jpg', 500, 20));
  const frame = f.element('iframe', { attrs: { src: '/detail.html' },
    rect: { top: 500, left: 100, width: 400, height: 200 } });
  Object.assign(frame, { contentDocument: child.doc, offsetWidth: 200, offsetHeight: 100,
    clientLeft: 2, clientTop: 2, clientWidth: 196, clientHeight: 96 });
  f.doc.body.append(frame, f.img('neighbor.jpg', 550, 90));
  const grab = f.run();
  assert.deepEqual(visible(grab), ['neighbor.jpg', 'inside.jpg'].map(url));
  const inside = grab.rows.find(row => row.url === url('inside.jpg'));
  assert.deepEqual([inside.top, inside.left], [554, 144]);
  assert.equal(grab.rows.find(row => row.url === url('outside.jpg')).top, null);
});

test('blocked iframe list refreshes when the child becomes accessible', () => {
  const f = fixture(), child = fixture();
  const frame = f.element('iframe', { attrs: { src: 'https://other.example/detail' } });
  Object.assign(frame, { contentDocument: null, clientWidth: 80, clientHeight: 80,
    offsetWidth: 80, offsetHeight: 80 });
  f.doc.body.append(frame);
  const grab = f.run();
  assert.deepEqual(Array.from(grab.blockedFrames), ['https://other.example/detail']);
  child.doc.body.append(child.img('recovered.jpg', 10));
  frame.contentDocument = child.doc;
  grab.scan();
  assert.equal(grab.blockedFrames.length, 0);
  assert.deepEqual(visible(grab), [url('recovered.jpg')]);
});

test('unavailable geometry keeps the media URL in the unplaced group', () => {
  const f = fixture();
  const broken = f.img('broken.jpg', 1);
  broken.rectError = true;
  f.doc.body.append(broken, f.img('working.jpg', 100));
  const grab = f.run();
  assert.deepEqual(urls(grab), ['working.jpg', 'broken.jpg'].map(url));
  assert.equal(grab.rows[1].top, null);
  assert.deepEqual(visible(grab), [url('working.jpg')]);
});

test('CSS references to inline SVG masks are excluded, including absolute and escaped fragments', () => {
  const f = fixture({ documentURL: `${base}#section` });
  f.doc.body.append(f.element('div', {
    attrs: { 'data-bg': 'url("#attributeMask")' },
    styles: {
      'mask-image': `url("${base}#_r_43_"), url("#localMask")`,
      '-webkit-mask-image': 'url("\\23 escapedMask")',
      'background-image': 'url("/real.jpg")'
    },
    pseudos: { '::before': { content: 'url("#pseudoMask")' } }
  }));
  const grab = f.run();
  assert.deepEqual(urls(grab), [url('/real.jpg')]);
  assert.deepEqual(visible(grab), [url('/real.jpg')]);
});

test('external SVG fragment URLs and data images remain collected', () => {
  const f = fixture();
  const embedded = 'data:image/svg+xml;base64,PHN2Zy8+';
  f.doc.body.append(f.element('div', { styles: {
    'mask-image': `url("/masks.svg#star"), url("https://cdn.example/mask.svg#shape"), url("${embedded}")`,
    'background-image': `url("${base}?variant=2#shape")`
  } }), f.img('/illustration.svg#view', 100));
  assert.deepEqual(new Set(urls(f.run())), new Set([
    url('/masks.svg#star'), 'https://cdn.example/mask.svg#shape', embedded,
    `${base}?variant=2#shape`, url('/illustration.svg#view')
  ]));
});

test('inline reference checks use the document URL even with a different base URI', () => {
  const f = fixture({ baseURI: 'https://cdn.example/assets/' });
  f.doc.body.append(f.element('div', { styles: {
    'mask-image': `url("${base}#local"), url("#alsoLocal"), url("external.svg#star")`
  } }));
  assert.deepEqual(urls(f.run()), ['https://cdn.example/assets/external.svg#star']);
});

test('iframe CSS reference checks use the child document rather than the top page', () => {
  const parentURL = 'https://shop.example/page.svg', childURL = 'https://shop.example/detail.svg';
  const f = fixture({ documentURL: parentURL, baseURI: parentURL });
  const child = fixture({ documentURL: childURL, baseURI: childURL });
  child.doc.body.append(child.element('div', { styles: {
    'mask-image': `url("${childURL}#local"), url("${parentURL}#external")`
  } }));
  const frame = f.element('iframe');
  Object.assign(frame, { contentDocument: child.doc, clientWidth: 80, clientHeight: 80,
    offsetWidth: 80, offsetHeight: 80 });
  f.doc.body.append(frame);
  assert.deepEqual(urls(f.run()), [`${parentURL}#external`]);
});

test('262 inline mask references do not inflate the count of 470 media URLs', () => {
  const f = fixture();
  const names = Array.from({ length: 470 }, (_, i) => `kept-${i}.jpg`);
  for (let i = 0; i < 262; i++) f.doc.body.append(f.element('div', {
    styles: { 'mask-image': `url("${base}#_r_${i}_")` }
  }));
  for (const [i, name] of names.entries()) f.doc.body.append(f.img(name, i * 100));
  const grab = f.run();
  assert.equal(grab.rows.length, 470);
  assert.deepEqual(urls(grab), names.map(url));
});

test('67 Mercury event addresses are excluded while 392 images and the CSS spinner GIF remain', () => {
  const trackers = Array.from({ length: 67 }, (_, i) => ({
    name: `https://mercury.coupang.com/e.gif?t=101&r=test-${i}`,
    initiatorType: ['beacon', 'fetch', 'xmlhttprequest', 'img'][i % 4]
  }));
  const f = fixture({ resources: trackers });
  for (let i = 0; i < 392; i++) f.doc.body.append(f.img(`image-${i}.jpg`, i * 100));
  const spinner = 'https://img1a.coupangcdn.com/image/sdp/spinner.gif';
  f.doc.body.append(f.element('div', { styles: {
    display: 'none', 'background-image': `url("${spinner}")`
  } }));
  const grab = f.run();
  assert.equal(grab.rows.length, 393);
  assert.deepEqual(Array.from(grab.rows.filter(row => row.type === 'GIF'), row => row.url), [spinner]);
  assert.equal(grab.excludedRows.length, 67);
  assert.deepEqual(new Set(Array.from(grab.excludedUrls)), new Set(trackers.map(row => row.name)));
  assert.ok(grab.excludedRows.every(row => row.reason && row.source === 'network'));
});

test('ordinary GIFs fetched through fetch or XHR remain in the network collection', () => {
  const f = fixture({ resources: [
    { name: url('/animation.gif'), initiatorType: 'fetch' },
    { name: url('/another.gif?size=large'), initiatorType: 'xmlhttprequest' }
  ] });
  const grab = f.run();
  assert.deepEqual(urls(grab), [url('/animation.gif'), url('/another.gif?size=large')]);
  assert.ok(grab.rows.every(row => row.type === 'GIF'));
  assert.equal(grab.excludedRows.length, 0);
});

test('Amazon telemetry is excluded from DOM and network media without dropping CDN files or similar paths', () => {
  const omit = [
    'https://www.amazon.com/rd/uedata?rid=test&rx=whole%2Fvalue',
    'https://amazon.com/rd/uedata?rid=another',
    'https://fls-na.amazon.com/1/batch/1/OP/test$uedata=s:metrics',
    'https://fls-na.amazon.com/1/remote-weblab-triggers/1/OE/test$s:wl-client-id=test'
  ];
  const keep = [
    'https://m.media-amazon.com/images/I/product.jpg?signature=whole%2Fvalue',
    'https://www.amazon.com/rd/uedata.jpg',
    'https://fls-na.amazon.com/images/animation.gif',
    'https://fls-na.amazon.com/1/batch/1/OTHER/file.mp4',
    'https://www.amazon.com.evil.example/rd/uedata',
    'https://fls-na.amazon.com.evil.example/1/batch/1/OP/image.jpg',
    'https://www.amazon.com@cdn.example/rd/uedata'
  ];
  const f = fixture({ resources: [...omit, ...keep].map(name => ({ name, initiatorType: 'img' })) });
  f.doc.body.append(f.img(omit[0], 100));
  const grab = f.run();
  assert.deepEqual(urls(grab), keep);
  assert.deepEqual(Array.from(grab.excludedUrls), omit);
  assert.ok(grab.excludedRows.every(row => /Amazon/.test(row.reason)));
  grab.scan({ quiet: true });
  assert.equal(grab.excludedRows.length, omit.length);
  assert.deepEqual(Array.from(grab.getManifest().items, row => row.url), keep);
});

test('exclusion is limited to the exact Mercury host and e.gif endpoint', () => {
  const keep = [
    'https://mercury.coupang.com/gallery/animation.gif',
    'https://mercury.coupang.com/other/e.gif',
    'https://cdn.example/e.gif',
    'https://mercury.coupang.com.evil.example/e.gif',
    'https://mercury.coupang.com@cdn.example/e.gif'
  ];
  const omit = ['http://mercury.coupang.com/e.gif?r=test',
    'https://MERCURY.COUPANG.COM/e.gif?t=101&r=test'];
  const f = fixture({ resources: [...keep, ...omit].map(name => ({ name, initiatorType: 'img' })) });
  const grab = f.run();
  assert.deepEqual(urls(grab), keep.map(url));
  assert.deepEqual(Array.from(grab.excludedUrls), omit.map(url));
});

test('Mercury event addresses found in DOM or CSS are excluded and diagnostics are deduplicated', () => {
  const event = 'https://mercury.coupang.com/e.gif?r=test';
  const f = fixture();
  f.doc.body.append(f.img(event, 10),
    f.element('div', { styles: { 'background-image': `url("${event}")` } }),
    f.element('a', { attrs: { href: event } }), f.img('/actual.gif', 100));
  const grab = f.run();
  assert.deepEqual(urls(grab), [url('/actual.gif')]);
  assert.deepEqual(visible(grab), [url('/actual.gif')]);
  assert.equal(grab.excludedRows.length, 1);
  const diagnostic = grab.excludedRows[0];
  diagnostic.reason = 'changed by caller';
  assert.notEqual(grab.excludedRows[0].reason, 'changed by caller');
});

test('scan preserves unique excluded address history and never adds it to the media results', () => {
  const events = [{ name: 'https://mercury.coupang.com/e.gif?r=first', initiatorType: 'fetch' }];
  const f = fixture({ resources: events });
  f.doc.body.append(f.img('/actual.gif', 100));
  const grab = f.run();
  grab.scan();
  assert.equal(grab.excludedRows.length, 1);
  events.push({ name: 'https://mercury.coupang.com/e.gif?r=second', initiatorType: 'beacon' });
  grab.scan();
  assert.equal(grab.excludedRows.length, 2);
  assert.deepEqual(urls(grab), [url('/actual.gif')]);
});

test('JSON manifest preserves full ordered addresses and omits excluded events', () => {
  const long = `https://cdn.example/${'a'.repeat(400)}/image.jpg?token=${'b'.repeat(400)}`;
  const f = fixture({ resources: [{ name: 'https://mercury.coupang.com/e.gif?r=test', initiatorType: 'beacon' }] });
  f.doc.title = '상품 테스트';
  f.doc.body.append(f.img(long, 500), f.img('/first.jpg', 10));
  const manifest = f.run().getManifest();
  assert.equal(manifest.schema, 'media-grab/1');
  assert.equal(manifest.collectorVersion, '2026.10.18.1');
  assert.equal(manifest.pageUrl, base);
  assert.equal(manifest.title, '상품 테스트');
  assert.ok(Number.isFinite(Date.parse(manifest.exportedAt)));
  assert.deepEqual(Array.from(manifest.items, row => row.url), [url('/first.jpg'), long]);
  assert.ok(!JSON.stringify(manifest).includes('…'));
});

test('visible-only manifest includes selected addresses in page order', () => {
  const f = fixture();
  f.doc.body.append(f.img('/fallback.jpg', 500, 10, { currentSrc: url('/selected.jpg') }),
    f.img('/first.jpg', 10));
  const grab = f.run();
  assert.equal(grab.getManifest().items.length, 3);
  const manifest = grab.getManifest({ visibleOnly: true });
  assert.equal(manifest.visibleOnly, true);
  assert.deepEqual(Array.from(manifest.items, row => row.url), [url('/first.jpg'), url('/selected.jpg')]);
});

test('export requests one JSON file and releases its temporary URL', async () => {
  const f = fixture();
  f.doc.body.append(f.img('/one.jpg', 10));
  let exportedBlob, clicked = 0, removed = 0, revoked;
  const timers = [];
  const link = { style: {}, click() { clicked++; }, remove() { removed++; } };
  f.context.Blob = Blob;
  f.context.URL = class extends URL {
    static createObjectURL(blob) { exportedBlob = blob; return 'blob:test-export'; }
    static revokeObjectURL(href) { revoked = href; }
  };
  f.context.setTimeout = (callback, delay) => { timers.push({ callback, delay }); };
  f.doc.createElement = tag => { assert.equal(tag, 'a'); return link; };
  f.doc.body.appendChild = element => { assert.equal(element, link); };
  const info = f.run().export();
  assert.equal(info.count, 1);
  assert.equal(link.download, 'shop.example.json');
  assert.equal(info.filename, link.download);
  assert.equal(clicked, 1);
  assert.equal(removed, 1);
  const content = JSON.parse(await exportedBlob.text());
  assert.equal(content.items[0].url, url('/one.jpg'));
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 60000);
  timers[0].callback();
  assert.equal(revoked, 'blob:test-export');
});

test('export names manifests after the page hostname and safely handles custom filenames', () => {
  const cases = [
    { page: 'https://www.coupang.com/vp/products/123?token=secret', expected: 'coupang.com.json' },
    { page: 'https://shop.coupang.com/kd1961/487603?source=brandstore_display_ads&adType=DA&eventId=example', expected: 'shop.coupang.com.json' },
    { page: 'https://shop.example.co.kr:8443/product#details', expected: 'shop.example.co.kr.json' },
    { page: 'https://store.json/product', expected: 'store.json.json' },
    { page: 'https://www.example.com/product', options: { visibleOnly: true }, expected: 'example.com.json' },
    { page: 'file:///tmp/product.html', expected: 'media-manifest.json' },
    { page: 'not a URL', expected: 'media-manifest.json' },
    { page: 'https://www.example.com', options: { filename: '쿠팡 리뷰' }, expected: '쿠팡 리뷰.json' },
    { page: 'https://www.example.com', options: { filename: 'custom.JSON' }, expected: 'custom.json' },
    { page: 'https://www.example.com', options: { filename: '  ' }, expected: 'example.com.json' },
    { page: 'https://www.example.com', options: { filename: '../bad\\name:*?\u0000.json' }, expected: '_bad_name____.json' },
    { page: 'https://www.example.com', options: { filename: 'CON' }, expected: '_CON.json' },
    { page: 'https://www.example.com', options: { filename: '...json' }, expected: 'media-manifest.json' },
    { page: `https://${'a'.repeat(63)}.example.com`, expected: `${'a'.repeat(60)}.json` }
  ];
  for (const { page, options = {}, expected } of cases) {
    const f = fixture({ documentURL: page, baseURI: 'https://cdn.example/assets/' });
    f.doc.title = 'Unrelated product title';
    f.doc.body.append(f.img('/one.jpg', 10));
    const link = { style: {}, click() {}, remove() {} };
    f.context.Blob = Blob;
    f.context.URL = class extends URL {
      static createObjectURL() { return 'blob:test-export'; }
      static revokeObjectURL() {}
    };
    f.context.setTimeout = () => {};
    f.doc.createElement = () => link;
    f.doc.body.appendChild = () => {};
    const grab = f.run();
    if (options.filename === undefined) assert.equal(grab.exportFilename, expected, page);
    const info = grab.export(options);
    assert.equal(link.download, expected, page);
    assert.equal(info.filename, expected, page);
    assert.equal(info.visibleOnly, Boolean(options.visibleOnly));
    assert.equal(info.count, 1);
  }
});

const gifBytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const pngBytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');

test('Amazon creator avatars remain images and do not become unresolved video thumbnails', () => {
  const f = fixture({ documentURL: 'https://www.amazon.com/dp/TEST', baseURI: 'https://www.amazon.com/dp/TEST' });
  const thumbnail = 'https://m.media-amazon.com/images/I/real-thumbnail.jpg';
  const avatar = 'https://m.media-amazon.com/images/I/creator-avatar.jpg';
  const card = f.element('div', { attrs: { 'data-element-id': 'video-carousel-item',
    'data-video-url': 'https://cdn.example/actual.mp4', 'data-title': 'Actual video' } });
  const profile = f.element('div', { attrs: { class: 'a-profile-avatar' } });
  profile.append(f.img(avatar, 50));
  card.append(f.img(thumbnail, 20, 0, { attrs: { alt: 'video thumbnail' } }), profile);
  f.doc.body.append(card);
  const grab = f.run();
  assert.equal(grab.amazonCollection.thumbnailsObserved, 1);
  assert.equal(grab.pendingVideos.length, 0);
  assert.ok(urls(grab).includes(avatar));
});

test('Amazon image state collects provided high resolution URLs for the selected color only', () => {
  const f = fixture({ documentURL: 'https://www.amazon.com/dp/TEST', baseURI: 'https://www.amazon.com/dp/TEST' });
  const image = name => 'https://m.media-amazon.com/images/I/' + name + '.jpg';
  const record = name => ({ variant: 'PT01', hiRes: image(name + '-hires'),
    thumb: image(name + '-thumb'), main: { [image(name + '-selected')]: [679, 679] } });
  const state = f.element('script', { attrs: { type: 'application/json' } });
  state.textContent = JSON.stringify({ landingAsinColor: 'Black', colorImages: { Black: [record('black')], Red: [record('red')] } });
  const initial = f.element('script');
  initial.textContent = "A.$.parseJSON('" + JSON.stringify([record('current')]) + "');";
  f.context.A = { $: { parseJSON() { assert.fail('page code must never be executed to read image state'); } } };
  f.doc.body.append(state, initial);
  const grab = f.run();
  for (const name of ['black-hires', 'black-thumb', 'black-selected', 'current-hires']) assert.ok(urls(grab).includes(image(name)));
  assert.ok(!urls(grab).some(href => href.includes('/red-')));
  assert.equal(grab.videos.length, 0);
});

test('an advertised Amazon video count exposes unopened gallery cards even with zero pending thumbnails', () => {
  const f = fixture({ documentURL: 'https://www.amazon.com/dp/TEST', baseURI: 'https://www.amazon.com/dp/TEST' });
  const label = f.element('div', { attrs: { id: 'altImages' } }); label.textContent = '10 VIDEOS';
  const card = f.element('div', { attrs: { 'data-element-id': 'video-carousel-item',
    'data-video-url': 'https://cdn.example/first.mp4' } });
  f.doc.body.append(label, card);
  const grab = f.run(), audit = grab.audit();
  assert.equal(grab.pendingVideos.length, 0);
  assert.equal(audit.expectedAmazonVideos, 10);
  assert.equal(audit.observedAmazonVideoCards, 1);
  assert.equal(audit.missingAmazonVideoCards, 9);
  assert.equal(audit.completeForObservedUrls, false);
});

test('related video cards cannot hide missing cards from the product gallery count', () => {
  const f = fixture({ documentURL: 'https://www.amazon.com/dp/TEST', baseURI: 'https://www.amazon.com/dp/TEST' });
  const label = f.element('div', { attrs: { id: 'altImages' } }); label.textContent = '10 VIDEOS';
  const card = id => f.element('div', { attrs: { 'data-element-id': 'video-carousel-item',
    'data-video-url': 'https://cdn.example/video-' + id + '.mp4' } });
  const related = f.element('div', { attrs: { id: 'vftphero-vse-related-videos' } });
  for (let i = 1; i <= 9; i++) related.append(card(i));
  f.doc.body.append(label, card(0), related);
  const grab = f.run(), audit = grab.audit();
  assert.equal(audit.observedAmazonVideoCards, 10);
  assert.equal(audit.observedAmazonProductVideoCards, 1);
  assert.equal(audit.observedAmazonRelatedVideoCards, 9);
  assert.equal(audit.missingAmazonVideoCards, 9);
});

test('page preparation loads delayed images, stops at the document end and restores the scroll position', async () => {
  const f = fixture({ scrollX: 5, scrollY: 90 }), win = f.doc.defaultView;
  f.doc.documentElement.scrollHeight = 1600; win.innerHeight = 400;
  win.setTimeout = fn => { queueMicrotask(fn); return 0; };
  let loaded = false;
  win.scrollTo = position => {
    win.scrollX = position.left; win.scrollY = position.top;
    if (!loaded && position.top >= 800) { loaded = true; f.doc.body.append(f.img('/late-original.gif', 1000)); }
  };
  const grab = f.run();
  const report = await grab.prepare({ gallery: false, maxScrolls: 10, settleMs: 20 });
  assert.ok(urls(grab).includes(url('/late-original.gif')));
  assert.ok(report.scrollSteps >= 5 && report.scrollSteps < 10);
  assert.deepEqual(Array.from(report.limitsReached), []);
  assert.equal(win.scrollX, 5); assert.equal(win.scrollY, 90);
});

test('Amazon preparation opens the known gallery, collects all cards, pauses new autoplay and restores the dialog', async () => {
  const f = watchFixture({ documentURL: 'https://www.amazon.com/dp/TEST', baseURI: 'https://www.amazon.com/dp/TEST' });
  f.doc.defaultView.setTimeout = fn => { queueMicrotask(fn); return 0; };
  const label = f.element('div', { attrs: { id: 'altImages' } }); label.textContent = '2 VIDEOS';
  const opener = f.element('a'); opener.textContent = 'Click to see full view';
  let open = false, loaded = false, paused = 0;
  const video = f.element('video'); video.muted = false; video.pause = () => paused++;
  const modal = { getBoundingClientRect: () => ({ height: open ? 400 : 0 }),
    querySelector: () => ({ click() { open = false; } }) };
  const panel = { closest: () => modal };
  opener.click = () => { open = true; };
  const tab = { click() {
    if (loaded) return; loaded = true;
    for (let i = 0; i < 2; i++) f.doc.body.append(f.element('div', { attrs: {
      'data-element-id': 'video-carousel-item', 'data-video-url': 'https://cdn.example/video-' + i + '.mp4' } }));
    f.doc.body.append(video); f.listeners.get('play')({ target: video });
  } };
  f.doc.querySelector = selector => selector === '#ivVideosTab' ? panel :
    selector === '#ivVideosTabHeading a' ? (open ? tab : null) :
    selector.includes('[data-element-id=') ? (loaded ? {} : null) : null;
  f.doc.body.append(label, opener);
  const grab = f.run(), report = await grab.prepare({ scroll: false, settleMs: 20 });
  assert.equal(report.galleryOpened, true);
  assert.equal(grab.amazonCollection.galleryVideosObserved, 2);
  assert.equal(grab.amazonCollection.missingVideoCards, 0);
  assert.equal(open, false); assert.equal(paused, 1); assert.equal(video.muted, false);
  grab.stopWatching();
});

test('an empty Amazon video tab reports a loading timeout even without an advertised video count', async () => {
  const f = fixture({ documentURL: 'https://www.amazon.com/dp/TEST', baseURI: 'https://www.amazon.com/dp/TEST' });
  f.doc.defaultView.setTimeout = callback => { queueMicrotask(callback); return 0; };
  let open = false;
  const opener = f.element('a'); opener.textContent = 'Click to see full view';
  opener.click = () => { open = true; };
  const tab = { click() {} }, modal = {
    getBoundingClientRect: () => ({ height: open ? 400 : 0 }),
    querySelector: () => ({ click() { open = false; } })
  };
  f.doc.querySelector = selector => selector === '#ivVideosTab' ? { closest: () => modal } :
    selector === '#ivVideosTabHeading a' && open ? tab : null;
  f.doc.body.append(opener);
  const grab = f.run(), report = await grab.prepare({ scroll: false, settleMs: 20 });
  assert.ok(report.warnings.some(message => /영상 카드 로딩 시간 초과/.test(message)));
  assert.equal(open, false);
});

test('the download audit retains real missing visible media and the ZIP preview uses only escaped local filenames', async () => {
  const failed = url('/unreadable.jpg');
  const f = downloadFixture({ [failed]: new TypeError('CORS blocked') });
  f.doc.body.append(f.img('/saved.gif', 0), f.img(failed, 100));
  const grab = f.run(), report = await grab.download({ prepare: false });
  assert.equal(report.audit.completeForObservedUrls, false);
  assert.equal(report.audit.missingVisibleUrls.length, 1);
  assert.equal(report.audit.missingVisibleUrls[0].url, failed);
  const files = await zipFiles(f.blobs.get(report.archives[0].url));
  const audit = JSON.parse(files.get('page-audit.json'));
  assert.equal(audit.finished, true);
  assert.equal(audit.missingUrls.length, 1);
  const preview = files.get('preview.html').toString();
  assert.match(preview, /src="0001.gif"/);
  assert.ok(!preview.includes('src="' + failed));
  assert.deepEqual(files.get('0001.gif'), gifBytes);
});

test('a known original from the same Video.js player covers its MediaSource without a blob fetch', async () => {
  const source = url('/same-player.mp4'), blob = 'blob:https://shop.example/player';
  const bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'),
    Buffer.alloc(4), Buffer.from('mp42isom'), Buffer.from([0, 0, 0, 8]), Buffer.from('mdat')]);
  const f = downloadFixture({ [source]: () => new Response(bytes), [blob]: () => assert.fail('MediaSource is not a file') });
  const wrapper = f.element('div', { attrs: { class: 'video-js' } });
  wrapper.player = { currentSource: () => ({ src: source, type: 'video/mp4' }) };
  wrapper.append(f.element('video', { attrs: { src: blob } })); f.doc.body.append(wrapper);
  const report = await f.run().download({ prepare: false });
  assert.ok(report.results.every(row => ['packed', 'covered'].includes(row.status)));
  assert.ok(!f.requests.some(request => request.href === blob));
  assert.equal(report.audit.missingUrls.length, 0);
});

test('media inserted while downloading is reported as not attempted rather than a complete page', async () => {
  let f;
  f = downloadFixture({ [url('/first.gif')]: () => {
    f.doc.body.append(f.img('/arrived-during-download.gif', 200));
    return new Response(gifBytes);
  } });
  f.doc.body.append(f.img('/first.gif', 0));
  const report = await f.run().download({ prepare: false });
  assert.equal(report.results.length, 1);
  assert.equal(report.audit.expectedUrls, 2);
  assert.equal(report.audit.completeForObservedUrls, false);
  assert.equal(report.audit.missingUrls[0].status, 'not-attempted');
  assert.equal(report.audit.missingUrls[0].url, url('/arrived-during-download.gif'));
  const files = await zipFiles(f.blobs.get(report.archives[0].url));
  assert.equal(JSON.parse(files.get('page-audit.json')).expectedUrls, 2);
});

test('download previews escape page supplied video titles and retain inaccessible frame diagnostics', async () => {
  const source = 'https://cdn.example/original.mp4';
  const title = 'x"><img src=x onerror=alert(1)> & title';
  const bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'),
    Buffer.alloc(4), Buffer.from('mp42isom'), Buffer.from([0, 0, 0, 8]), Buffer.from('mdat')]);
  const f = downloadFixture({ [source]: new Response(bytes) },
    { documentURL: 'https://www.amazon.com/dp/TEST', baseURI: 'https://www.amazon.com/dp/TEST' });
  f.doc.body.append(f.element('div', { attrs: { 'data-element-id': 'video-carousel-item',
    'data-title': title, 'data-video-url': source } }),
    f.element('iframe', { attrs: { src: 'https://external.example/frame' } }));
  const report = await f.run().download({ prepare: false });
  assert.deepEqual(Array.from(report.audit.blockedFrames), ['https://external.example/frame']);
  const files = await zipFiles(f.blobs.get(report.archives[0].url));
  const preview = files.get('preview.html').toString();
  assert.ok(!preview.includes(title));
  assert.match(preview, /&lt;img src=x onerror=alert\(1\)&gt; &amp; title/);
  assert.ok(!preview.includes('<script'));
});

function downloadFixture(routes = {}, options = {}) {
  const f = fixture(options), blobs = new Map(), saves = [], revoked = [], requests = [];
  f.context.Blob = Blob;
  f.context.TextEncoder = TextEncoder;
  f.context.TextDecoder = TextDecoder;
  f.context.AbortController = AbortController;
  f.context.setTimeout = setTimeout;
  f.context.clearTimeout = clearTimeout;
  f.context.URL = class extends URL {
    static createObjectURL(blob) { const key = `blob:zip-${blobs.size}`; blobs.set(key, blob); return key; }
    static revokeObjectURL(href) { revoked.push(href); }
  };
  f.context.fetch = async (href, options) => {
    requests.push({ href, options });
    const route = routes[href];
    if (route instanceof Error) throw route;
    if (typeof route === 'function') return route(options);
    return route || new Response(gifBytes, { headers: { 'Content-Type': 'image/gif' } });
  };
  f.doc.createElement = tag => {
    assert.equal(tag, 'a');
    return { style: {}, click() { saves.push({ href: this.href, filename: this.download }); }, remove() {} };
  };
  f.doc.body.appendChild = () => {};
  return { ...f, blobs, saves, revoked, requests };
}

// Read local ZIP STORE records independently of the writer. The browser
// integration test also validates the complete ZIP with Python's zipfile.
async function zipFiles(blob) {
  const bytes = Buffer.from(await blob.arrayBuffer()), files = new Map();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0);
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
    const dataStart = offset + 30 + nameLength + extraLength;
    files.set(bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8'), bytes.subarray(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50);
  assert.equal(bytes.readUInt16LE(bytes.length - 12), files.size);
  return files;
}

test('browser ZIP stores YouTube as a link without fetching a watch page or claiming a video', async () => {
  const f = downloadFixture({});
  f.doc.body.append(f.element('iframe', { attrs: { src: 'https://www.youtube.com/embed/M7lc1UVf-VE' } }));
  const report = await f.run().download();
  assert.equal(f.requests.length, 0);
  assert.equal(report.results[0].status, 'link');
  assert.equal(report.results[0].filename, '0001.url');
  const files = await zipFiles(f.blobs.get(report.archives[0].url));
  assert.match(files.get('0001.url').toString(), /URL=https:\/\/www.youtube.com\/watch\?v=M7lc1UVf-VE/);
});

test('browser ZIP preserves page order and GIF bytes and corrects misleading extensions', async () => {
  const f = downloadFixture({ [url('/top.jpg')]: new Response(pngBytes) });
  f.doc.body.append(f.img('/bottom.jpg', 500), f.img('/top.jpg', 10));
  const result = await f.run().download();
  assert.equal(result.results.length, 2);
  assert.deepEqual(Array.from(result.results, row => row.filename), ['0001.png', '0002.gif']);
  assert.equal(result.archives.length, 1);
  assert.equal(f.saves.length, 1);
  const files = await zipFiles(f.blobs.get(result.archives[0].url));
  assert.deepEqual([...files.keys()], ['0001.png', '0002.gif', 'download-report.json', 'download-report.csv', 'failed.csv', 'page-audit.json', 'preview.html']);
  assert.deepEqual(files.get('0002.gif'), gifBytes);
  assert.deepEqual(files.get('0001.png'), pngBytes);
  for (const { options } of f.requests) {
    assert.equal(options.mode, 'cors');
    assert.equal(options.credentials, 'same-origin');
  }
});

test('console download waits for an already observed Amazon list response before fixing its targets', async () => {
  const record = amazonRecord(0, { sources: [{ src: 'https://cdn.example/late-original.mp4', type: 'video/mp4' }] });
  const bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'),
    Buffer.alloc(4), Buffer.from('mp42isom'), Buffer.from([0, 0, 0, 8]), Buffer.from('mdat')]);
  const f = downloadFixture({ [record.sources[0].src]: new Response(bytes) },
    { documentURL: 'https://www.amazon.com/dp/TEST', baseURI: 'https://www.amazon.com/dp/TEST' });
  let resolveList;
  const response = new Promise(resolve => { resolveList = resolve; });
  f.doc.defaultView.fetch = () => response;
  const grab = f.run(); await grab.ready;
  const pagePromise = f.doc.defaultView.fetch('/gp/video/list');
  assert.equal(pagePromise, response);
  assert.equal(grab.videos.length, 0);
  const pending = grab.download();
  resolveList(new Response(JSON.stringify({ videos: [record] }), { headers: { 'Content-Type': 'application/json' } }));
  const report = await pending;
  const original = report.results.find(row => row.url === record.sources[0].src);
  assert.equal(original.status, 'packed');
  assert.equal(original.thumbnailUrl, record.thumbnailUrl);
  assert.equal(report.amazonCollection.pendingThumbnails, 0);
  const files = await zipFiles(f.blobs.get(report.archives[0].url));
  assert.deepEqual(files.get(original.filename), bytes);
  const json = JSON.parse(files.get('download-report.json'));
  assert.equal(json.collectorVersion, '2026.10.18.1');
  assert.equal(json.amazonCollection.thumbnailsWithOriginal, 1);
  assert.deepEqual(json.pendingVideos, []);
});

test('browser ZIP downloads the original Video.js MP4 source instead of its native blob', async () => {
  const source = url('/review/original.mp4?signature=full-value');
  const bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'),
    Buffer.alloc(4), Buffer.from('mp42isom'), Buffer.from([0, 0, 0, 8]), Buffer.from('mdat')]);
  const blob = 'blob:https://shop.example/media-source';
  const f = downloadFixture({
    [source]: new Response(bytes, { headers: { 'Content-Type': 'video/mp4' } }),
    [blob]: new TypeError('MediaSource cannot be fetched as a file')
  });
  const wrapper = f.element('div', { attrs: { class: 'video-js vjs-v7' } });
  wrapper.player = { currentSource: () => ({ src: source, type: 'video/mp4' }) };
  wrapper.append(f.element('video', { attrs: { src: blob } }));
  f.doc.body.append(wrapper);
  const grab = f.run(), row = grab.rows.find(r => r.url === source);
  const result = await grab.download({ start: row.order, end: row.order });
  assert.equal(result.results[0].status, 'packed');
  assert.equal(result.results[0].source, 'videojs.currentSource');
  assert.equal(result.results[0].filename, '0001.mp4');
  assert.deepEqual(f.requests.map(r => r.href), [source]);
  const files = await zipFiles(f.blobs.get(result.archives[0].url));
  assert.deepEqual(files.get('0001.mp4'), bytes);
});

test('browser ZIP retains readable blob files and reports unresolved blobs without guessing a source', async () => {
  const readable = 'blob:https://shop.example/complete-file', unresolved = 'blob:https://shop.example/unknown-player';
  const unrelated = url('/unrelated.mp4');
  const videoBytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'),
    Buffer.alloc(4), Buffer.from('mp42isom'), Buffer.from([0, 0, 0, 8]), Buffer.from('mdat')]);
  const f = downloadFixture({
    [readable]: new Response(videoBytes), [unresolved]: new TypeError('Failed to fetch'),
    [unrelated]: new Response(videoBytes)
  });
  for (const src of [readable, unresolved, unrelated]) f.doc.body.append(f.element('video', { attrs: { src } }));
  const report = await f.run().download();
  assert.deepEqual(Array.from(report.results, row => [row.status, row.filename]),
    [['packed', '0001.mp4'], ['failed', ''], ['packed', '0003.mp4']]);
  assert.match(report.results[1].message, /임시 blob/);
  assert.match(report.results[1].message, /원본 MP4·HLS 확인/);
  assert.equal(report.results[1].url, unresolved);
  const files = await zipFiles(f.blobs.get(report.archives[0].url));
  assert.deepEqual(files.get('0001.mp4'), videoBytes);
  assert.deepEqual(files.get('0003.mp4'), videoBytes);
  assert.ok(!files.has('0002.mp4'));
  assert.match(files.get('failed.csv').toString(), /unknown-player/);
});

test('browser ZIP rejects OK, HTML, JSON, HTTP errors and unreadable responses without saving false media', async () => {
  const f = downloadFixture({
    [url('/ok.gif')]: new Response('OK', { headers: { 'Content-Type': 'image/gif' } }),
    [url('/html.jpg')]: new Response('<html>denied</html>'),
    [url('/json.png')]: new Response('{"status":404}'),
    [url('/http.jpg')]: new Response('blocked', { status: 403 }),
    [url('/cors.jpg')]: new TypeError('Failed to fetch'),
    [url('/opaque.jpg')]: { type: 'opaque', status: 0, headers: new Headers() }
  });
  for (const [i, name] of ['ok.gif', 'html.jpg', 'json.png', 'http.jpg', 'cors.jpg', 'opaque.jpg', 'valid.gif'].entries()) f.doc.body.append(f.img('/' + name, i * 100));
  const result = await f.run().download();
  assert.deepEqual(Array.from(result.results, row => row.status), ['failed', 'failed', 'failed', 'failed', 'failed', 'failed', 'packed']);
  assert.equal(result.results[3].httpStatus, 403);
  const files = await zipFiles(f.blobs.get(result.archives[0].url));
  assert.deepEqual([...files.keys()].filter(name => /^\d/.test(name)), ['0007.gif']);
  const report = JSON.parse(files.get('download-report.json'));
  assert.equal(report.results.filter(row => row.status === 'failed').length, 6);
  assert.match(files.get('failed.csv').toString('utf8'), /cors\.jpg/);
});

test('browser ZIP uses selected visible addresses and retains original order numbers for ranges', async () => {
  const f = downloadFixture();
  f.doc.body.append(f.img('/fallback.jpg', 100, 0, { currentSrc: url('/selected.jpg') }), f.img('/bottom.gif', 200));
  const result = await f.run().download({ visibleOnly: true, start: 2 });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].order, 3);
  assert.equal(result.results[0].filename, '0003.gif');
  assert.equal(f.requests[0].href, url('/bottom.gif'));
});

test('browser ZIP splits large batches into independent archives and can retry a save or release URLs', async () => {
  const f = downloadFixture();
  f.doc.body.append(f.img('/one.gif', 100), f.img('/two.gif', 200));
  const grab = f.run(), result = await grab.download({ maxZipMB: gifBytes.length / 1024 ** 2 });
  assert.equal(result.archives.length, 2);
  const first = await zipFiles(f.blobs.get(result.archives[0].url));
  const second = await zipFiles(f.blobs.get(result.archives[1].url));
  assert.deepEqual([...first.keys()].filter(name => /^\d/.test(name)), ['0001.gif']);
  assert.deepEqual([...second.keys()].filter(name => /^\d/.test(name)), ['0002.gif']);
  assert.equal(JSON.parse(first.get('download-report.json')).results.length, 1);
  grab.saveArchive(2);
  assert.equal(f.saves.length, 3);
  assert.equal(f.saves[2].href, result.archives[1].url);
  grab.clearDownloads();
  assert.deepEqual(f.revoked, Array.from(result.archives, archive => archive.url));
  assert.equal(grab.lastDownload, null);
});

test('all split ZIPs contain the same final audit, with global totals and local file reports', async () => {
  const f = downloadFixture();
  f.doc.body.append(f.img('/first.gif', 0), f.img('/second.gif', 100));
  const report = await f.run().download({ prepare: false, maxZipMB: gifBytes.length / 1024 ** 2 });
  assert.equal(report.archives.length, 2);
  for (const [index, archive] of report.archives.entries()) {
    const files = await zipFiles(f.blobs.get(archive.url));
    const audit = JSON.parse(files.get('page-audit.json'));
    const local = JSON.parse(files.get('download-report.json'));
    assert.deepEqual(audit, JSON.parse(JSON.stringify(report.audit)));
    assert.equal(audit.finished, true);
    assert.equal(audit.completeForObservedUrls, true);
    assert.equal(audit.missingUrls.length, 0);
    assert.equal(local.session.totalResults, 2);
    assert.equal(local.session.totalParts, 2);
    assert.equal(local.session.part, index + 1);
    assert.equal(local.session.finishedAt, report.finishedAt);
    assert.equal(local.results.length, 1);
    assert.ok(files.has(local.results[0].filename));
    assert.deepEqual(local.audit, audit);
  }
});

test('failed hidden resources stay failures while visible coverage and blocked-frame scope remain distinct', async () => {
  const hidden = url('/hidden.jpg'), f = downloadFixture({ [hidden]: new TypeError('CORS blocked') });
  f.doc.body.append(f.img('/visible.gif', 0), f.img(hidden, 100, 0, { styles: { display: 'none' } }),
    f.element('iframe', { attrs: { src: 'https://external.example/frame' } }));
  const grab = f.run(), report = await grab.download({ prepare: false });
  assert.equal(report.results.find(row => row.url === hidden).status, 'failed');
  assert.equal(report.audit.completeForObservedUrls, false);
  assert.equal(report.audit.completeForVisibleUrls, true);
  assert.equal(report.audit.completeForLoadedPage, false);
  assert.deepEqual(JSON.parse(JSON.stringify(grab.audit())), JSON.parse(JSON.stringify(report.audit)));
  assert.equal(grab.audit().blockedFrames.length, 1);
});

test('an inaccessible frame prevents loaded-page completeness even when every observed URL was saved', async () => {
  const f = downloadFixture();
  f.doc.body.append(f.img('/visible.gif', 0), f.element('iframe', { attrs: { src: 'https://external.example/frame' } }));
  const grab = f.run(), report = await grab.download({ prepare: false });
  assert.equal(report.audit.completeForObservedUrls, true);
  assert.equal(report.audit.completeForLoadedPage, false);
  assert.equal(grab.audit().completeForLoadedPage, false);
});

test('unreadable video-list metadata prevents a successful completeness audit despite successful media reads', async () => {
  const f = downloadFixture({}, { documentURL: 'https://www.amazon.com/dp/TEST', baseURI: 'https://www.amazon.com/dp/TEST' });
  f.doc.defaultView.fetch = async () => new Response('unavailable', { status: 503 });
  f.doc.body.append(f.img('/visible.gif', 0));
  const grab = f.run(); await grab.ready;
  await f.doc.defaultView.fetch('/gp/video/list');
  await grab.collectVideos({ refresh: false });
  const report = await grab.download({ prepare: false });
  assert.equal(report.results[0].status, 'packed');
  assert.equal(report.audit.missingUrls.length, 0);
  assert.equal(report.audit.collectionErrors.length, 1);
  assert.match(report.audit.collectionErrors[0].message, /503/);
  assert.equal(report.audit.completeForObservedUrls, false);
  assert.equal(report.audit.completeForVisibleUrls, false);
});

test('unfinished observed metadata responses remain pending in the final download audit', async () => {
  const f = downloadFixture({}, { documentURL: 'https://www.amazon.com/dp/TEST', baseURI: 'https://www.amazon.com/dp/TEST' });
  f.doc.defaultView.fetch = () => new Promise(() => {});
  f.doc.defaultView.setTimeout = callback => { queueMicrotask(callback); return 1; };
  f.doc.defaultView.clearTimeout = () => {};
  f.doc.body.append(f.img('/visible.gif', 0));
  const grab = f.run(); await grab.ready;
  f.doc.defaultView.fetch('/gp/video/list');
  const report = await grab.download({ prepare: false });
  assert.equal(report.results[0].status, 'packed');
  assert.equal(report.audit.pendingResponses, 1);
  assert.equal(report.audit.completeForObservedUrls, false);
  grab.stopWatching();
});

test('high-resolution and deferred image attributes are collected and their later mutations remain observable', () => {
  const f = watchFixture();
  const image = f.img('/selected.jpg', 100, 0, { attrs: {
    'data-a-hires': '/hires.jpg', 'data-hires': '/hires-alternative.jpg', 'data-img': '/deferred.gif'
  } });
  f.doc.body.append(image);
  const grab = f.run();
  for (const name of ['/selected.jpg', '/hires.jpg', '/hires-alternative.jpg', '/deferred.gif']) {
    assert.ok(urls(grab).includes(url(name)), name);
  }
  assert.deepEqual(visible(grab), [url('/selected.jpg')]);
  assert.ok(f.mutations[0].options.attributeFilter.includes('data-hires'));
  image.attrs['data-hires'] = '/new-hires.gif';
  f.mutations[0].callback([{ type: 'attributes', target: image, attributeName: 'data-hires' }]);
  assert.ok(urls(grab).includes(url('/new-hires.gif')));
  grab.stopWatching();
});

test('browser ZIP bounds downloads even without Content-Length and leaves oversized files in failed report', async () => {
  const f = downloadFixture({
    [url('/stream.gif')]: new Response(gifBytes),
    [url('/length.gif')]: new Response(gifBytes, { headers: { 'Content-Length': String(gifBytes.length) } })
  });
  f.doc.body.append(f.img('/stream.gif', 100), f.img('/length.gif', 200));
  const result = await f.run().download({ maxFileMB: 16 / 1024 ** 2 });
  assert.ok(result.results.every(row => row.status === 'failed' && row.message.includes('크기 제한')));
  const files = await zipFiles(f.blobs.get(result.archives[0].url));
  assert.equal([...files.keys()].filter(name => /^\d/.test(name)).length, 0);
});

test('browser ZIP timeout ends an unreadable request and continues with remaining URLs', async () => {
  const f = downloadFixture({ [url('/timeout.gif')]: ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }) });
  f.doc.body.append(f.img('/timeout.gif', 100), f.img('/works.gif', 200));
  const result = await f.run().download({ timeoutMs: 10 });
  assert.equal(result.results[0].status, 'failed');
  assert.match(result.results[0].message, /대기 시간/);
  assert.equal(result.results[1].status, 'packed');
});

test('browser ZIP cancellation retains a report and prevents overlapping downloads', async () => {
  const f = downloadFixture({ [url('/wait.gif')]: ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }) });
  f.doc.body.append(f.img('/wait.gif', 100), f.img('/next.gif', 200));
  const grab = f.run(), pending = grab.download();
  await assert.rejects(grab.download(), /이미 다운로드 중/);
  assert.throws(() => grab.clearDownloads(), /다운로드 중/);
  grab.stopDownload();
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.ok(result.results.every(row => row.status === 'skipped'));
  assert.equal(f.requests.length, 1);
});

test('explicit playlist option stores stream playlists without claiming a complete video', async () => {
  const f = downloadFixture({ [url('/video.m3u8')]: new Response('#EXTM3U\npart.ts\n') });
  f.doc.body.append(f.element('a', { attrs: { href: '/video.m3u8' } }));
  const result = await f.run().download({ hls: 'playlist' });
  assert.equal(result.results[0].status, 'playlist');
  assert.equal(result.results[0].filename, '0001.m3u8');
  assert.match(result.results[0].message, /영상 조각/);
});


