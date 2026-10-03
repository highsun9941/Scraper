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
  assert.equal(link.download, 'media-manifest.json');
  assert.equal(clicked, 1);
  assert.equal(removed, 1);
  const content = JSON.parse(await exportedBlob.text());
  assert.equal(content.items[0].url, url('/one.jpg'));
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 60000);
  timers[0].callback();
  assert.equal(revoked, 'blob:test-export');
});

const gifBytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const pngBytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');

function downloadFixture(routes = {}) {
  const f = fixture(), blobs = new Map(), saves = [], revoked = [], requests = [];
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

test('browser ZIP preserves page order and GIF bytes and corrects misleading extensions', async () => {
  const f = downloadFixture({ [url('/top.jpg')]: new Response(pngBytes) });
  f.doc.body.append(f.img('/bottom.jpg', 500), f.img('/top.jpg', 10));
  const result = await f.run().download();
  assert.equal(result.results.length, 2);
  assert.deepEqual(Array.from(result.results, row => row.filename), ['0001.png', '0002.gif']);
  assert.equal(result.archives.length, 1);
  assert.equal(f.saves.length, 1);
  const files = await zipFiles(f.blobs.get(result.archives[0].url));
  assert.deepEqual([...files.keys()], ['0001.png', '0002.gif', 'download-report.json', 'download-report.csv', 'failed.csv']);
  assert.deepEqual(files.get('0002.gif'), gifBytes);
  assert.deepEqual(files.get('0001.png'), pngBytes);
  for (const { options } of f.requests) {
    assert.equal(options.mode, 'cors');
    assert.equal(options.credentials, 'same-origin');
  }
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

test('browser ZIP stores stream playlists without claiming a complete video', async () => {
  const f = downloadFixture({ [url('/video.m3u8')]: new Response('#EXTM3U\npart.ts\n') });
  f.doc.body.append(f.element('a', { attrs: { href: '/video.m3u8' } }));
  const result = await f.run().download();
  assert.equal(result.results[0].status, 'playlist');
  assert.equal(result.results[0].filename, '0001.m3u8');
  assert.match(result.results[0].message, /영상 조각/);
});
