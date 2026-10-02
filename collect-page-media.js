(() => {
  const found = new Map(), blockedFrames = new Set();
  let styles, layouts, elementOrder;
  const guess = u => {
    if (/\.gif(?:$|[?#])|^data:image\/gif[;,]/i.test(u)) return "GIF";
    if (/\.(?:m3u8|mpd)(?:$|[?#])/i.test(u)) return "STREAM";
    if (/\.(?:mp4|webm|m4v|mov|ogv|avi|mkv|mpg|mpeg)(?:$|[?#])|^data:video\//i.test(u)) return "VIDEO";
    if (/\.(?:jpe?g|png|webp|avif|svg|bmp|ico|apng|tiff?)(?:$|[?#])|^data:image\//i.test(u)) return "IMAGE";
    return "";
  };
  const absolute = (raw, base) => {
    if (!raw || typeof raw !== "string" || !raw.trim()) return null;
    try { return new URL(raw.trim(), base).href; } catch { return null; }
  };
  const comparePosition = (a, b) => a.top - b.top || a.left - b.left;
  const styleOf = el => {
    if (!styles.has(el)) {
      try { styles.set(el, el.ownerDocument.defaultView.getComputedStyle(el)); }
      catch { styles.set(el, null); }
    }
    return styles.get(el);
  };
  const parentOf = el => el.parentElement || el.getRootNode?.().host || null;
  const box = (el, ctx) => {
    const r = el.getBoundingClientRect();
    const left = ctx.x + r.left * ctx.sx, top = ctx.y + r.top * ctx.sy;
    return { left, top, right: left + r.width * ctx.sx, bottom: top + r.height * ctx.sy };
  };
  const intersect = (a, b) => ({
    left: Math.max(a.left, b.left), top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom)
  });
  // 페이지 전체 좌표를 사용합니다. 화면 아래쪽의 일반 문서 요소도 포함합니다.
  const locate = (el, ctx) => {
    if (layouts.has(el)) return layouts.get(el);
    let result = null;
    try {
      let r = box(el, ctx);
      let rendered = ctx.visible && r.right > r.left && r.bottom > r.top;
      const doc = el.ownerDocument, ownStyle = styleOf(el);
      if (["hidden", "collapse"].includes(ownStyle?.visibility)) rendered = false;
      for (let p = el; p && rendered; p = parentOf(p)) {
        const s = styleOf(p);
        if (s?.display === "none" || parseFloat(s?.opacity) === 0) rendered = false;
        if (p !== el && p !== doc.documentElement && p !== doc.body) {
          const clipX = /^(hidden|clip|scroll|auto)$/.test(s?.overflowX || s?.overflow || "");
          const clipY = /^(hidden|clip|scroll|auto)$/.test(s?.overflowY || s?.overflow || "");
          if (clipX || clipY) {
            const c = box(p, ctx);
            r = intersect(r, {
              left: clipX ? c.left : -Infinity, right: clipX ? c.right : Infinity,
              top: clipY ? c.top : -Infinity, bottom: clipY ? c.bottom : Infinity
            });
          }
        }
      }
      if (ctx.clip) r = intersect(r, ctx.clip);
      if (rendered && r.right > r.left && r.bottom > r.top &&
          [r.left, r.top, r.right, r.bottom].every(Number.isFinite)) {
        result = { top: Math.round(r.top * 100) / 100, left: Math.round(r.left * 100) / 100 };
      }
    } catch {}
    layouts.set(el, result);
    return result;
  };
  const add = (raw, kind, base, source, position = null, visible = false, element = Infinity) => {
    const href = absolute(raw, base);
    if (!href) return;
    try {
      const u = new URL(href);
      if (!/^(?:https?:|blob:|data:)$/.test(u.protocol)) return;
      if (u.protocol === "data:" && !/^data:(?:image|video)\//i.test(href)) return;
      const type = guess(href) || kind;
      if (!type) return;
      let row = found.get(href);
      if (!row) {
        row = { type, url: href, source, temporary: u.protocol === "blob:",
          position: null, visible: false, element: Infinity, discovery: found.size };
        found.set(href, row);
      } else if (row.type === "IMAGE" && type !== "IMAGE") {
        Object.assign(row, { type, source });
      }
      visible = Boolean(position && visible);
      // 같은 URL은 실제 표시되는 첫 위치를 우선합니다. 숨긴 복제본은 뒤로 둡니다.
      if (position && ((!row.visible && visible) ||
          row.visible === visible && (!row.position || comparePosition(position, row.position) < 0 ||
          comparePosition(position, row.position) === 0 && element < row.element))) {
        Object.assign(row, { position, visible, element, source });
      }
    } catch {}
  };
  const srcset = (text, kind, base, source, position, primary, element) => {
    let i = 0;
    while (i < text.length) {
      while (i < text.length && /[\s,]/.test(text[i])) i++;
      const start = i;
      while (i < text.length && !/\s/.test(text[i])) i++;
      const token = text.slice(start, i);
      if (!token) break;
      const raw = token.replace(/,+$/, "");
      add(raw, kind, base, source, position, absolute(raw, base) === primary, element);
      if (token.endsWith(",")) continue;
      let depth = 0;
      while (i < text.length) {
        const c = text[i++];
        if (c === "(") depth++;
        if (c === ")") depth--;
        if (c === "," && depth === 0) break;
      }
    }
  };
  const css = (text, base, source, position, visible, element) => {
    const re = /url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^)]*))\s*\)/gi;
    for (const m of String(text || "").matchAll(re)) {
      const raw = (m[1] ?? m[2] ?? m[3]).trim().replace(
        /\\([\da-f]{1,6})\s?|\\(.)/gi,
        (_, hex, ch) => {
          if (!hex) return ch;
          const cp = parseInt(hex, 16);
          return String.fromCodePoint(cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? cp : 0xfffd);
        }
      );
      add(raw, "IMAGE", base, source, position, visible, element);
    }
  };
  const walk = (root, seen, ctx) => {
    if (!root || seen.has(root)) return;
    seen.add(root);
    const doc = root.ownerDocument || root, win = doc.defaultView;
    if (!win) return;
    if (!seen.has(win)) {
      seen.add(win);
      let resources = [];
      try { resources = win.performance?.getEntriesByType?.("resource") || []; } catch {}
      for (const r of resources) {
        const kind = r.initiatorType === "img" ? "IMAGE" : r.initiatorType === "video" ? "VIDEO" : "";
        add(r.name, kind, doc.baseURI, "network");
      }
    }
    for (const el of root.querySelectorAll("*")) {
      const element = elementOrder++, tag = el.localName, parent = el.parentElement?.localName;
      const base = el.baseURI || doc.baseURI;
      const owner = tag === "source" ?
        (parent === "picture" ? el.parentElement.querySelector("img") : el.parentElement) : el;
      const position = owner ? locate(owner, ctx) : null;
      let primary = owner?.currentSrc || owner?.getAttribute("src") ||
        owner?.getAttribute("data") || owner?.getAttribute("href") || owner?.getAttribute("xlink:href");
      primary = absolute(primary, base);
      const emit = (raw, kind, source, painted = absolute(raw, base) === primary) =>
        add(raw, kind, base, source, position, painted, element);
      let kind = tag === "video" || (tag === "source" && parent === "video") ? "VIDEO" :
        ["img", "image"].includes(tag) || (tag === "source" && parent === "picture") ||
        (tag === "input" && el.type === "image") ? "IMAGE" : "";
      if (/^image\/gif$/i.test(el.getAttribute("type") || "")) kind = "GIF";
      if (["object", "embed"].includes(tag)) {
        const mime = el.getAttribute("type") || "";
        kind = /^image\/gif$/i.test(mime) ? "GIF" : /^image\//i.test(mime) ? "IMAGE" : /^video\//i.test(mime) ? "VIDEO" : kind;
        emit(el.getAttribute("data") || el.getAttribute("src"), kind, tag);
      }
      if (kind) {
        emit(el.currentSrc, kind, `${tag}.currentSrc`);
        for (const a of ["src", "data-src", "data-original", "data-lazy-src", "data-original-src", "data-url", "data-large"]) {
          emit(el.getAttribute(a), kind, `${tag}.${a}`);
        }
        if (kind !== "VIDEO") for (const a of ["srcset", "data-srcset", "data-lazy-srcset"]) {
          srcset(el.getAttribute(a) || "", kind, base, `${tag}.${a}`, position, primary, element);
        }
      }
      if (tag === "image") emit(el.getAttribute("href") || el.getAttribute("xlink:href"), "IMAGE", "svg.image");
      if (tag === "video") emit(el.getAttribute("poster"), "IMAGE", "video.poster", true);
      if (["a", "link"].includes(tag)) add(el.getAttribute("href"), "", base, `${tag}.href`);
      for (const a of ["data-bg", "data-background", "data-background-image", "data-image", "data-image-src", "data-video-src", "data-video-url", "data-poster"]) {
        const value = el.getAttribute(a);
        if (!value) continue;
        if (/url\(/i.test(value)) css(value, base, a, position, false, element);
        else if (/^(?:https?:|blob:|data:|\/|\.{1,2}\/)/i.test(value) || guess(value)) {
          emit(value, a.includes("video") ? "VIDEO" : "IMAGE", a, false);
        }
      }
      for (const pseudo of [null, "::before", "::after"]) {
        try {
          const s = pseudo ? win.getComputedStyle(el, pseudo) : styleOf(el);
          if (!s) continue;
          const painted = s.display !== "none" && !["hidden", "collapse"].includes(s.visibility) &&
            parseFloat(s.opacity) !== 0 && (!pseudo || !["none", "normal", ""].includes(s.content));
          for (const prop of ["background-image", "content", "border-image-source", "list-style-image", "mask-image", "-webkit-mask-image"]) {
            css(s.getPropertyValue(prop), base, `css${pseudo || ""}.${prop}`, locate(el, ctx), painted, element);
          }
        } catch {}
      }
      if (el.shadowRoot) walk(el.shadowRoot, seen, ctx);
      if (tag === "iframe") {
        try {
          const child = el.contentDocument;
          if (!child) { blockedFrames.add(el.src || "접근할 수 없는 iframe"); continue; }
          const r = el.getBoundingClientRect(), full = box(el, ctx);
          const sx = ctx.sx * (el.offsetWidth ? r.width / el.offsetWidth : 1);
          const sy = ctx.sy * (el.offsetHeight ? r.height / el.offsetHeight : 1);
          const x = full.left + (el.clientLeft || 0) * sx, y = full.top + (el.clientTop || 0) * sy;
          let clip = { left: x, top: y, right: x + el.clientWidth * sx, bottom: y + el.clientHeight * sy };
          // 부모의 잘린 영역과 iframe 자체의 viewport를 모두 적용합니다.
          if (ctx.clip) clip = intersect(clip, ctx.clip);
          const shown = locate(el, ctx);
          if (shown) {
            const frameBox = box(el, ctx);
            for (let p = parentOf(el); p && p !== doc.documentElement && p !== doc.body; p = parentOf(p)) {
              const s = styleOf(p), c = box(p, ctx);
              const clipX = /^(hidden|clip|scroll|auto)$/.test(s?.overflowX || s?.overflow || "");
              const clipY = /^(hidden|clip|scroll|auto)$/.test(s?.overflowY || s?.overflow || "");
              if (clipX || clipY) clip = intersect(clip, {
                left: clipX ? c.left : -Infinity, right: clipX ? c.right : Infinity,
                top: clipY ? c.top : -Infinity, bottom: clipY ? c.bottom : Infinity
              });
            }
            clip = intersect(clip, frameBox);
          }
          walk(child, seen, { x, y, sx, sy, visible: Boolean(shown), clip });
        } catch { blockedFrames.add(el.src || "접근할 수 없는 iframe"); }
      }
    }
  };
  const ordered = () => [...found.values()].sort((a, b) => {
    if (Boolean(a.position) !== Boolean(b.position)) return a.position ? -1 : 1;
    if (a.position && b.position) return comparePosition(a.position, b.position) ||
      Number(b.visible) - Number(a.visible) || a.element - b.element || a.discovery - b.discovery;
    return a.discovery - b.discovery;
  }).map((r, i) => ({
    order: i + 1, type: r.type, url: r.url, source: r.source, temporary: r.temporary,
    top: r.position?.top ?? null, left: r.position?.left ?? null, visible: r.visible
  }));
  window.mediaGrab = {
    get rows() { return ordered(); },
    get urls() { return this.rows.map(r => r.url); },
    get visibleRows() { return this.rows.filter(r => r.visible); },
    get visibleUrls() { return this.visibleRows.map(r => r.url); },
    get blockedFrames() { return [...blockedFrames]; },
    scan() {
      styles = new WeakMap(); layouts = new WeakMap(); elementOrder = 0;
      blockedFrames.clear();
      for (const row of found.values()) Object.assign(row, { position: null, visible: false, element: Infinity });
      const win = document.defaultView || window;
      walk(document, new Set(), {
        x: Number(win.scrollX) || Number(document.documentElement?.scrollLeft) || 0,
        y: Number(win.scrollY) || Number(document.documentElement?.scrollTop) || 0,
        sx: 1, sy: 1, visible: true, clip: null
      });
      const rows = this.rows;
      console.table(rows);
      console.log(`총 ${found.size}개 URL (페이지 좌표 순서, 위치 미확인 주소는 뒤쪽)\n${rows.map(r => r.url).join("\n")}`);
      console.log(`표시 요소의 선택 주소 ${this.visibleUrls.length}개: copy(mediaGrab.visibleUrls.join('\\n'))`);
      if (blockedFrames.size) console.log("접근할 수 없는 iframe:", this.blockedFrames);
      return rows;
    }
  };
  window.mediaGrab.scan();
})();
