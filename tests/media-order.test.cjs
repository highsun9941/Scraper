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
function fixture({ scrollX = 0, scrollY = 0, resources = [] } = {}) {
  const doc = { baseURI: base, ownerDocument: null };
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
      localName: tag, ownerDocument: doc, baseURI: base, parentElement: null,
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
  return { doc, element, img, shadow, run };
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
