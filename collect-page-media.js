(() => {
  // 스니펫을 다시 실행하면 이전 감시기를 해제합니다.
  try { window.mediaGrab?.stopWatching?.(); } catch {}
  const found = new Map(), excluded = new Map(), blockedFrames = new Set(), reviewPreviews = new Map();
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
  const add = (raw, kind, base, source, position = null, visible = false, element = Infinity, metadata = null) => {
    const href = absolute(raw, base);
    if (!href) return;
    try {
      const u = new URL(href);
      if (!/^(?:https?:|blob:|data:)$/.test(u.protocol)) return;
      if (u.protocol === "data:" && !/^data:(?:image|video)\//i.test(href)) return;
      // 확장자가 .gif여도 이벤트 수집용 엔드포인트는 미디어가 아닙니다.
      // 알려진 정확한 주소만 제외해 일반 GIF와 영상 요청은 유지합니다.
      if (u.hostname === "mercury.coupang.com" && u.pathname === "/e.gif") {
        if (!excluded.has(href)) excluded.set(href, {
          url: href, source, reason: "통계·이벤트 수집 주소 (Coupang Mercury)"
        });
        return;
      }
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
      if (metadata) Object.assign(row, metadata);
      visible = Boolean(position && visible);
      // 같은 URL은 실제 표시되는 첫 위치를 우선합니다. 숨긴 복제본은 뒤로 둡니다.
      if (position && ((!row.visible && visible) ||
          row.visible === visible && (!row.position || comparePosition(position, row.position) < 0 ||
          comparePosition(position, row.position) === 0 && element < row.element))) {
        Object.assign(row, { position, visible, element, source });
      }
    } catch {}
  };
  const youtube = (raw, base) => {
    try {
      const u = new URL(raw, base), host = u.hostname.toLowerCase();
      if (!/^https?:$/.test(u.protocol)) return null;
      let id = "";
      if (host === "youtu.be" || host === "www.youtu.be") id = u.pathname.split("/")[1];
      else if (/^(?:(?:www|m)\.)?youtube\.com$/.test(host) || /^(?:www\.)?youtube-nocookie\.com$/.test(host)) {
        id = u.pathname === "/watch" ? u.searchParams.get("v") :
          u.pathname.match(/^\/(?:embed|v|shorts|live)\/([^/]+)\/?$/)?.[1];
      }
      if (!/^[\w-]{11}$/.test(id || "") || ["videoseries", "live_stream"].includes(id)) return null;
      return { provider: "youtube", videoId: id, embedUrl: u.href,
        url: `https://www.youtube.com/watch?v=${id}` };
    } catch { return null; }
  };
  const addEmbed = (raw, base, source, position = null, visible = false, element = Infinity) => {
    const info = youtube(raw, base);
    if (info) add(info.url, "EMBED", base, source, position, visible, element,
      { provider: info.provider, videoId: info.videoId, embedUrl: info.embedUrl });
  };
  const addResource = (r, base) => {
    const kind = r.initiatorType === "img" ? "IMAGE" : r.initiatorType === "video" ? "VIDEO" : "";
    add(r.name, kind, base, "network");
    if (r.initiatorType === "iframe") addEmbed(r.name, base, "network.iframe");
  };
  const reviewKey = (raw, base) => {
    try {
      const u = new URL(raw, base);
      return u.hostname === "video.coupangcdn.com" &&
        /^\/cloud\/PRODUCTREVIEW\/.+\/transcode\/origin_thumbnail\.\d+\.jpg$/i.test(u.pathname) ?
        u.origin + u.pathname.slice(0, u.pathname.indexOf("/transcode/") + 1) : null;
    } catch { return null; }
  };
  const rememberPreview = (raw, base) => {
    const key = reviewKey(raw, base), href = absolute(raw, base);
    if (key && href && !reviewPreviews.has(key)) reviewPreviews.set(key, href);
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
  const css = (text, base, source, position, visible, element, documentURL = base) => {
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
      // url(#id)는 페이지 안의 SVG 참조이며 별도 이미지 파일이 아닙니다.
      // 계산된 CSS가 이를 문서의 절대 URL로 바꾼 경우도 제외합니다.
      if (raw.startsWith("#")) continue;
      const href = absolute(raw, base);
      if (!href) continue;
      try {
        const target = new URL(href), page = new URL(documentURL);
        if (target.hash) {
          target.hash = ""; page.hash = "";
          if (target.href === page.href) continue;
        }
      } catch {}
      add(href, "IMAGE", base, source, position, visible, element);
    }
  };
  // Video.js는 <video>.currentSrc에 blob을 놓고 원본 소스를 별도로 보관할 수 있습니다.
  // 이미 있는 재생기만 읽습니다. videojs() 호출로 재생기를 만들거나 src를 바꾸지 않습니다.
  const videojsSources = (el, win, ctx, base, element) => {
    if (!["video", "video-js"].includes(el.localName) &&
        !String(el.getAttribute("class") || "").split(/\s+/).includes("video-js")) return;
    const readable = p => p && ["currentSource", "currentSources", "currentSrc"].some(name => typeof p[name] === "function");
    let player;
    try { if (readable(el.player)) player = el.player; } catch {}
    if (!player) {
      try { const existing = win.videojs?.getPlayer?.(el); if (readable(existing)) player = existing; } catch {}
    }
    if (!player) return;
    try { if (typeof player.isAudio === "function" && player.isAudio()) return; } catch { return; }
    const read = name => { try { return typeof player[name] === "function" ? player[name]() : null; } catch { return null; } };
    const sources = [];
    const collect = (value, method) => {
      const source = typeof value === "string" ? { src: value } : value;
      if (source && typeof source.src === "string") sources.push({ ...source, method });
    };
    collect(read("currentSource"), "currentSource");
    if (!sources.some(source => source.src)) collect({ src: read("currentSrc"), type: read("currentType") }, "currentSrc");
    const selectedSrc = sources.find(source => source.src)?.src;
    const alternatives = read("currentSources");
    if (Array.isArray(alternatives)) for (const source of alternatives) collect(source, "currentSources");
    const media = el.localName === "video" ? el : el.querySelector("video") || el;
    const position = locate(media, ctx), mediaBase = media.baseURI || base;
    const selected = absolute(selectedSrc, mediaBase);
    for (const source of sources) {
      const mime = String(source.type || "").split(";")[0].trim();
      const kind = /^(?:application\/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml)|audio\/(?:x-)?mpegurl)$/i.test(mime) ? "STREAM" : "VIDEO";
      add(source.src, kind, mediaBase, `videojs.${source.method}`, position,
        absolute(source.src, mediaBase) === selected, element);
    }
  };
  // 동적 팝업은 닫히기 전에 읽습니다. 재생을 시작하거나 src를 변경하지 않습니다.
  const captureMedia = (el, ctx, element = Infinity) => {
    if (!el?.localName) return;
    const tag = el.localName, base = el.baseURI || el.ownerDocument?.baseURI;
    const win = el.ownerDocument?.defaultView;
    if (!win) return;
    const previewSources = tag === "img" ? [el.currentSrc, ...["src", "data-src", "data-original"].map(a => el.getAttribute(a))] : [];
    if (!["video", "video-js", "iframe", "object", "embed"].includes(tag) &&
        !String(el.getAttribute("class") || "").split(/\s+/).includes("video-js") &&
        !previewSources.some(raw => reviewKey(raw, base))) return;
    const position = el.isConnected === false ? null : locate(el, ctx);
    if (["iframe", "object", "embed"].includes(tag)) {
      const primary = absolute(el.src || el.getAttribute("src") || el.getAttribute("data"), base);
      for (const attr of ["src", "data", "data-src", "data-lazy-src", "data-original-src"]) {
        const raw = el.getAttribute(attr);
        if (raw) addEmbed(raw, base, `${tag}.${attr}`, position,
          absolute(raw, base) === primary, element);
      }
    }
    if (tag === "img") {
      for (const raw of previewSources) {
        if (reviewKey(raw, base)) {
          rememberPreview(raw, base);
          add(raw, "IMAGE", base, "review.thumbnail", position,
            absolute(raw, base) === absolute(el.currentSrc || el.getAttribute("src"), base), element);
        }
      }
    }
    if (tag === "video") {
      const primary = absolute(el.currentSrc || el.getAttribute("src"), base);
      add(el.currentSrc, "VIDEO", base, "video.currentSrc", position, true, element);
      for (const attr of ["src", "data-src", "data-video-src", "data-video-url"]) {
        const raw = el.getAttribute(attr);
        add(raw, "VIDEO", base, `video.${attr}`, position, absolute(raw, base) === primary, element);
      }
      for (const child of el.querySelectorAll("source")) {
        if (child.localName === "source") add(child.getAttribute("src"), "VIDEO", child.baseURI || base,
          "source.src", position, absolute(child.getAttribute("src"), base) === primary, element);
      }
      add(el.getAttribute("poster"), "IMAGE", base, "video.poster", position, true, element);
    }
    try { videojsSources(el, win, ctx, base, element); } catch {}
  };
  let watching = false, pollTimer = null;
  let watchedRoots = new Map(), watchedWindows = new Map();
  const cleanups = new Set();
  const captureTree = (root, ctx) => {
    styles = new WeakMap(); layouts = new WeakMap();
    if ((root?.ownerDocument || root) === document) {
      ctx = { ...ctx, x: Number(window.scrollX) || 0, y: Number(window.scrollY) || 0 };
    }
    captureMedia(root, ctx);
    for (const el of root?.querySelectorAll?.("video, video-js, .video-js, iframe, object, embed, img") || []) {
      captureMedia(el, ctx);
      if (el.shadowRoot) captureTree(el.shadowRoot, ctx);
    }
  };
  const observeRoot = (root, ctx) => {
    if (!watching) return;
    if (watchedRoots.has(root)) { watchedRoots.set(root, ctx); return; }
    watchedRoots.set(root, ctx);
    const win = (root.ownerDocument || root).defaultView;
    if (!win) return;
    const event = e => {
      if (!watching) return;
      captureTree(e.target, watchedRoots.get(root) || ctx);
      if (e.target?.localName === "iframe") window.mediaGrab.scan({ quiet: true });
    };
    for (const name of ["load", "loadstart", "loadedmetadata", "loadeddata", "canplay", "play"]) {
      root.addEventListener?.(name, event, true);
      cleanups.add(() => root.removeEventListener?.(name, event, true));
    }
    try {
      if (typeof win.MutationObserver === "function") {
        const observer = new win.MutationObserver(records => {
          if (!watching) return;
          const context = watchedRoots.get(root) || ctx;
          for (const record of records) {
            captureTree(record.target, context);
            for (const node of [...(record.addedNodes || []), ...(record.removedNodes || [])]) {
              captureTree(node, context);
              if (node.shadowRoot) observeRoot(node.shadowRoot, context);
            }
          }
        });
        observer.observe(root, { childList: true, subtree: true, attributes: true,
          attributeFilter: ["src", "data", "data-src", "data-lazy-src", "data-original-src", "poster", "data-video-src", "data-video-url"] });
        cleanups.add(() => observer.disconnect());
      }
    } catch {}
    if (watchedWindows.has(win)) return;
    watchedWindows.set(win, true);
    try {
      if (typeof win.PerformanceObserver === "function") {
        const observer = new win.PerformanceObserver(list => {
          if (watching) for (const resource of list.getEntries()) addResource(resource, (root.ownerDocument || root).baseURI);
        });
        observer.observe({ type: "resource", buffered: true });
        cleanups.add(() => observer.disconnect());
      }
    } catch {}
  };
  const walk = (root, seen, ctx) => {
    if (!root || seen.has(root)) return;
    seen.add(root);
    const doc = root.ownerDocument || root, win = doc.defaultView;
    if (!win) return;
    observeRoot(root, ctx);
    const documentURL = doc.URL || doc.location?.href || win.location?.href || doc.baseURI;
    if (!seen.has(win)) {
      seen.add(win);
      let resources = [];
      try { resources = win.performance?.getEntriesByType?.("resource") || []; } catch {}
      for (const r of resources) addResource(r, doc.baseURI);
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
      captureMedia(el, ctx, element);
      if (["a", "link"].includes(tag)) add(el.getAttribute("href"), "", base, `${tag}.href`);
      for (const a of ["data-bg", "data-background", "data-background-image", "data-image", "data-image-src", "data-video-src", "data-video-url", "data-poster"]) {
        const value = el.getAttribute(a);
        if (!value) continue;
        if (/url\(/i.test(value)) css(value, base, a, position, false, element, documentURL);
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
            css(s.getPropertyValue(prop), base, `css${pseudo || ""}.${prop}`, locate(el, ctx), painted, element, documentURL);
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
    top: r.position?.top ?? null, left: r.position?.left ?? null, visible: r.visible,
    ...(r.provider ? { provider: r.provider, videoId: r.videoId, embedUrl: r.embedUrl } : {})
  }));
  // 외부 라이브러리 없이 ZIP STORE를 만듭니다. 원본 미디어를 재인코딩하지 않습니다.
  const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
    for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1;
    return n >>> 0;
  });
  const crcUpdate = (crc, bytes) => {
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8;
    return crc;
  };
  const mediaExtension = bytes => {
    const starts = signature => signature.every((byte, i) => bytes[i] === byte);
    const ascii = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
    if (starts([255, 216, 255])) return ".jpg";
    if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return ".png";
    if (["GIF87a", "GIF89a"].includes(ascii(0, 6))) return ".gif";
    if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return ".webp";
    if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "AVI ") return ".avi";
    if (["II*\0", "MM\0*", "II+\0", "MM\0+"].includes(ascii(0, 4))) return ".tiff";
    if (ascii(0, 2) === "BM" && bytes.length >= 14) return ".bmp";
    if (starts([0, 0, 1, 0]) && bytes.length >= 6) return ".ico";
    if (ascii(4, 8) === "ftyp") {
      const end = Math.min(bytes.length, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0));
      const brands = [ascii(8, 12)];
      for (let i = 16; i + 4 <= end; i += 4) brands.push(ascii(i, i + 4));
      if (brands.some(x => ["avif", "avis"].includes(x))) return ".avif";
      if (brands.some(x => ["heic", "heix", "hevc", "hevx"].includes(x))) return ".heic";
      if (brands.some(x => ["mif1", "msf1"].includes(x))) return ".heif";
      return brands.includes("qt  ") ? ".mov" : ".mp4";
    }
    if (starts([26, 69, 223, 163])) return ascii(0, 4096).includes("webm") ? ".webm" : ".mkv";
    if (ascii(0, 4) === "OggS") return ".ogv";
    if (starts([0, 0, 1, 186]) || starts([0, 0, 1, 179])) return ".mpeg";
    let text = new TextDecoder().decode(bytes).trimStart();
    if (text.startsWith("#EXTM3U")) return ".m3u8";
    text = text.replace(/^<\?xml\b[\s\S]*?\?>\s*/, "");
    while (text.startsWith("<!--") && text.includes("-->")) text = text.slice(text.indexOf("-->") + 3).trimStart();
    text = text.replace(/^<!DOCTYPE\s+svg\b[^>]*>\s*/i, "");
    if (/^<svg(?:\s|>)/.test(text)) return ".svg";
    if (/^<(?:[\w.-]+:)?MPD(?:\s|>)/.test(text)) return ".mpd";
    return null;
  };
  const textEntry = (name, text) => {
    const bytes = new TextEncoder().encode(text);
    return { name, blob: new Blob([bytes]), size: bytes.length, crc: (crcUpdate(0xffffffff, bytes) ^ 0xffffffff) >>> 0 };
  };
  const makeZip = entries => {
    const encoder = new TextEncoder(), local = [], central = [];
    let offset = 0, centralSize = 0;
    const now = new Date(), year = Math.min(2107, Math.max(1980, now.getFullYear()));
    const time = now.getHours() << 11 | now.getMinutes() << 5 | now.getSeconds() >>> 1;
    const date = year - 1980 << 9 | now.getMonth() + 1 << 5 | now.getDate();
    if (entries.length >= 65535) throw new Error("ZIP 항목 수가 너무 많습니다.");
    for (const entry of entries) {
      const name = encoder.encode(entry.name), header = new Uint8Array(30 + name.length);
      const h = new DataView(header.buffer);
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
      h.setUint16(10, time, true); h.setUint16(12, date, true); h.setUint32(14, entry.crc, true);
      h.setUint32(18, entry.size, true); h.setUint32(22, entry.size, true); h.setUint16(26, name.length, true);
      header.set(name, 30);
      const directory = new Uint8Array(46 + name.length), d = new DataView(directory.buffer);
      d.setUint32(0, 0x02014b50, true); d.setUint16(4, 20, true); d.setUint16(6, 20, true);
      d.setUint16(8, 0x0800, true); d.setUint16(12, time, true); d.setUint16(14, date, true);
      d.setUint32(16, entry.crc, true); d.setUint32(20, entry.size, true); d.setUint32(24, entry.size, true);
      d.setUint16(28, name.length, true); d.setUint32(42, offset, true); directory.set(name, 46);
      local.push(header, entry.blob); central.push(directory);
      offset += header.length + entry.size; centralSize += directory.length;
      if (offset + centralSize + 22 >= 0xffffffff) throw new Error("ZIP32의 용량 한도를 넘었습니다.");
    }
    const end = new Uint8Array(22), e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true);
    e.setUint32(12, centralSize, true); e.setUint32(16, offset, true);
    return new Blob([...local, ...central, end], { type: "application/zip" });
  };
  const requestSave = (href, filename) => {
    const link = document.createElement("a");
    link.href = href; link.download = filename; link.style.display = "none";
    (document.body || document.documentElement).appendChild(link);
    try { link.click(); } finally { link.remove(); }
  };
  const reportCSV = rows => {
    const fields = ["order", "status", "filename", "bytes", "httpStatus", "contentType", "url", "message"];
    const quote = value => `"${String(value ?? "").replace(/"/g, '""')}"`;
    return "\ufeff" + [fields, ...rows.map(row => fields.map(field => row[field]))]
      .map(row => row.map(quote).join(",")).join("\r\n") + "\r\n";
  };
  const readMedia = async (url, options, signal) => {
    const controller = new AbortController(), abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(abort, options.timeoutMs);
    let response;
    try {
      response = await fetch(url, { mode: "cors", credentials: options.credentials, signal: controller.signal });
      if (response.type === "opaque" || response.type === "opaqueredirect") throw new Error("응답 내용을 읽을 권한이 없습니다.");
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      if (Number(response.headers.get("Content-Length")) > options.maxFileBytes) throw new Error("파일 크기 제한을 넘었습니다.");
      if (!response.body) throw new Error("응답 본문이 없습니다.");
      const reader = response.body.getReader(), chunks = [], prefix = new Uint8Array(16384);
      let size = 0, prefixSize = 0, crc = 0xffffffff;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > options.maxFileBytes) throw new Error("파일 크기 제한을 넘었습니다.");
          const head = value.subarray(0, prefix.length - prefixSize);
          prefix.set(head, prefixSize); prefixSize += head.length;
          crc = crcUpdate(crc, value); chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const extension = mediaExtension(prefix.subarray(0, prefixSize));
      if (!extension) throw new Error("지원하는 미디어 형식이 아닙니다. OK·HTML·JSON 또는 손상된 응답일 수 있습니다.");
      return { blob: new Blob(chunks), size, crc: (crc ^ 0xffffffff) >>> 0, extension,
        httpStatus: response.status, contentType: response.headers.get("Content-Type") || "" };
    } catch (error) {
      const message = signal.aborted ? "사용자가 중단했습니다." : controller.signal.aborted ? "요청 대기 시간을 넘었습니다." :
        error instanceof TypeError ? `브라우저에서 응답을 읽지 못했습니다(CORS·CSP·접속 제한 등): ${error.message}` : error.message;
      const failure = new Error(message);
      failure.httpStatus = response?.status || ""; failure.contentType = response?.headers.get("Content-Type") || "";
      throw failure;
    } finally { clearTimeout(timer); controller.abort(); signal.removeEventListener("abort", abort); }
  };
  let downloadController = null, downloadReport = null;
  window.mediaGrab = {
    get rows() { return ordered(); },
    get urls() { return this.rows.map(r => r.url); },
    get visibleRows() { return this.rows.filter(r => r.visible); },
    get visibleUrls() { return this.visibleRows.map(r => r.url); },
    get excludedRows() { return [...excluded.values()].map(r => ({ ...r })); },
    get excludedUrls() { return [...excluded.keys()]; },
    get blockedFrames() { return [...blockedFrames]; },
    get embeds() { return this.rows.filter(r => r.type === "EMBED"); },
    get videos() { return this.rows.filter(r => ["VIDEO", "STREAM", "EMBED"].includes(r.type) && !r.temporary); },
    get pendingVideos() {
      return [...reviewPreviews].filter(([key]) => ![...found.values()].some(row =>
        ["VIDEO", "STREAM"].includes(row.type) && !row.temporary && row.url.startsWith(key)))
        .map(([, thumbnailUrl]) => {
          const row = found.get(thumbnailUrl);
          return { thumbnailUrl, top: row?.position?.top ?? null, left: row?.position?.left ?? null,
            visible: row?.visible || false, message: "썸네일만 확인됨. 리뷰 영상을 재생해 원본 주소를 수집하세요." };
        });
    },
    get watching() { return watching; },
    watch({ intervalMs = 1000, quiet = true } = {}) {
      if (!Number.isFinite(intervalMs) || intervalMs < 250 || intervalMs > 60000) throw new Error("intervalMs는 250~60000이어야 합니다.");
      this.stopWatching(); watching = true;
      this.scan({ quiet });
      if (typeof window.setInterval === "function") pollTimer = window.setInterval(() => {
        // 재생기 API가 DOM 변경 없이 원본 소스를 뒤늦게 설정하는 경우를 보완합니다.
        for (const [root, ctx] of watchedRoots) {
          try { captureTree(root, ctx); } catch {}
        }
      }, intervalMs);
      console.log("영상 감시 시작: 리뷰 영상을 하나씩 재생하세요. 종료: mediaGrab.stopWatching()");
      return { watching, intervalMs };
    },
    stopWatching() {
      watching = false;
      if (pollTimer !== null) window.clearInterval?.(pollTimer);
      pollTimer = null;
      for (const cleanup of cleanups) { try { cleanup(); } catch {} }
      cleanups.clear(); watchedRoots = new Map(); watchedWindows = new Map();
      return { watching: false };
    },
    get lastDownload() { return downloadReport; },
    clearDownloads() {
      if (downloadController) throw new Error("다운로드 중에는 결과를 해제할 수 없습니다.");
      for (const archive of downloadReport?.archives || []) URL.revokeObjectURL(archive.url);
      downloadReport = null;
    },
    stopDownload() { downloadController?.abort(); },
    saveArchive(index = 1) {
      const archive = downloadReport?.archives[index - 1];
      if (!archive) throw new Error("해당 ZIP이 없습니다. mediaGrab.lastDownload.archives를 확인하세요.");
      requestSave(archive.url, archive.filename);
      return { filename: archive.filename, downloadRequested: true };
    },
    async download({ visibleOnly = false, start = 1, end = Infinity, maxFileMB = 256,
        maxZipMB = 256, timeoutMs = 30000, credentials = "same-origin" } = {}) {
      if (downloadController) throw new Error("이미 다운로드 중입니다. 중단하려면 mediaGrab.stopDownload()를 실행하세요.");
      this.scan({ quiet: true });
      if (![maxFileMB, maxZipMB].every(x => Number.isFinite(x) && x > 0 && x <= 1024) ||
          !Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(start) || start < 1 ||
          !(end === Infinity || Number.isInteger(end) && end >= start) ||
          !["same-origin", "omit", "include"].includes(credentials)) throw new Error("다운로드 옵션을 확인하세요.");
      const rows = (visibleOnly ? this.visibleRows : this.rows).filter(row => row.order >= start && row.order <= end);
      if (!rows.length) throw new Error("대상 주소가 없습니다. 상세내용을 펼치고 mediaGrab.scan()으로 다시 수집하세요.");
      this.clearDownloads();
      downloadController = new AbortController();
      const signal = downloadController.signal, width = Math.max(4, String(rows.at(-1).order).length);
      const options = { timeoutMs, credentials, maxFileBytes: Math.floor(maxFileMB * 1024 ** 2) };
      const zipLimit = Math.floor(maxZipMB * 1024 ** 2), stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
      const pageUrl = document.URL || document.baseURI;
      downloadReport = { schema: "media-grab-download/1", pageUrl, startedAt: new Date().toISOString(),
        finishedAt: null, results: [], archives: [], cancelled: false };
      let entries = [], partResults = [], partBytes = 0;
      const flush = () => {
        if (!partResults.length) return;
        const index = downloadReport.archives.length + 1, filename = `page-media-${stamp}-${String(index).padStart(3, "0")}.zip`;
        const blob = makeZip([...entries,
          textEntry("download-report.json", JSON.stringify({ pageUrl, results: partResults }, null, 2)),
          textEntry("download-report.csv", reportCSV(partResults)),
          textEntry("failed.csv", reportCSV(partResults.filter(row => ["failed", "skipped"].includes(row.status))))]);
        const archive = { index, filename, bytes: blob.size, url: URL.createObjectURL(blob), downloadRequested: false };
        downloadReport.archives.push(archive);
        try { requestSave(archive.url, filename); archive.downloadRequested = true; }
        catch (error) { archive.message = error.message; }
        console.log(`ZIP ${index} 저장 요청: ${filename}. 시작되지 않으면 mediaGrab.saveArchive(${index})`);
        entries = []; partResults = []; partBytes = 0;
      };
      console.log(`브라우저에서 ${rows.length}개 주소를 읽어 ZIP으로 저장합니다. 중단: mediaGrab.stopDownload()`);
      try {
        for (const [i, row] of rows.entries()) {
          const result = { ...row, status: "failed", filename: "", bytes: 0, httpStatus: "", contentType: "", message: "" };
          if (signal.aborted) Object.assign(result, { status: "skipped", message: "사용자가 중단했습니다." });
          else if (row.type === "EMBED") {
            const filename = `${String(row.order).padStart(width, "0")}.url`;
            const link = textEntry(filename, `[InternetShortcut]\r\nURL=${row.url}\r\n`);
            if (entries.length && partBytes + link.size > zipLimit) flush();
            entries.push(link); partBytes += link.size;
            Object.assign(result, { status: "link", filename, bytes: link.size,
              message: "유튜브 영상 페이지 링크를 저장했습니다. 영상 파일은 download-videos.py로 다운로드하세요." });
          } else {
            try {
              const data = await readMedia(row.url, options, signal);
              if (entries.length && (partBytes + data.size > zipLimit || entries.length >= 10000)) flush();
              const filename = `${String(row.order).padStart(width, "0")}${data.extension}`;
              entries.push({ name: filename, ...data }); partBytes += data.size;
              Object.assign(result, { status: [".m3u8", ".mpd"].includes(data.extension) ? "playlist" : "packed",
                filename, bytes: data.size, httpStatus: data.httpStatus, contentType: data.contentType });
              if (result.status === "playlist") result.message = "재생목록만 저장합니다. 영상 조각을 합치지는 않습니다.";
            } catch (error) {
              Object.assign(result, { status: signal.aborted ? "skipped" : "failed", message: error.message,
                httpStatus: error.httpStatus || "", contentType: error.contentType || "" });
            }
          }
          partResults.push(result); downloadReport.results.push(result);
          if ((i + 1) % 25 === 0 || i + 1 === rows.length) console.log(`ZIP 준비 ${i + 1}/${rows.length}`);
        }
        flush();
        downloadReport.cancelled = signal.aborted; downloadReport.finishedAt = new Date().toISOString();
        const packed = downloadReport.results.filter(row => row.status === "packed").length;
        const playlists = downloadReport.results.filter(row => row.status === "playlist").length;
        const links = downloadReport.results.filter(row => row.status === "link").length;
        console.log(`완료: 미디어 ${packed}개 / 재생목록 ${playlists}개 / 외부 영상 링크 ${links}개 / 실패·건너뜀 ${rows.length - packed - playlists - links}개 / ZIP ${downloadReport.archives.length}개`);
        if (this.pendingVideos.length) console.log(`아직 썸네일만 확인된 리뷰 영상 ${this.pendingVideos.length}개: mediaGrab.pendingVideos`);
        console.log("상세 결과: mediaGrab.lastDownload. ZIP 안의 failed.csv에서 실패 주소를 확인하세요.");
        return downloadReport;
      } finally { downloadController = null; }
    },
    getManifest({ visibleOnly = false } = {}) {
      this.scan({ quiet: true });
      return {
        schema: "media-grab/1",
        pageUrl: document.URL || document.location?.href || document.baseURI,
        title: document.title || "",
        exportedAt: new Date().toISOString(),
        visibleOnly: Boolean(visibleOnly),
        items: visibleOnly ? this.visibleRows : this.rows,
        blockedFrames: this.blockedFrames,
        pendingVideos: this.pendingVideos
      };
    },
    export(options = {}) {
      const manifest = this.getManifest(options);
      const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json;charset=utf-8" });
      const href = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = href;
      link.download = "media-manifest.json";
      link.style.display = "none";
      (document.body || document.documentElement).appendChild(link);
      try { link.click(); }
      finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(href), 60000);
      }
      console.log(`주소 ${manifest.items.length}개의 목록 파일 저장을 요청했습니다: media-manifest.json`);
      return { filename: "media-manifest.json", count: manifest.items.length, visibleOnly: manifest.visibleOnly };
    },
    scan({ quiet = false } = {}) {
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
      if (quiet) return rows;
      console.table(rows);
      console.log(`총 ${found.size}개 URL (페이지 좌표 순서, 위치 미확인 주소는 뒤쪽)\n${rows.map(r => r.url).join("\n")}`);
      console.log(`표시 요소의 선택 주소 ${this.visibleUrls.length}개: copy(mediaGrab.visibleUrls.join('\\n'))`);
      console.log("일괄 다운로드용 목록 파일 저장: mediaGrab.export()");
      console.log("설치 없이 브라우저에서 ZIP 다운로드: await mediaGrab.download()");
      if (excluded.size) console.log(`미디어에서 제외한 통계·이벤트 주소 ${excluded.size}개: mediaGrab.excludedRows`);
      if (blockedFrames.size) console.log("접근할 수 없는 iframe:", this.blockedFrames);
      console.log(`외부 영상 ${this.embeds.length}개 / 원본 영상·재생목록 ${this.videos.length - this.embeds.length}개 / 미확인 리뷰 영상 ${this.pendingVideos.length}개`);
      if (this.pendingVideos.length) console.log("미확인 리뷰 영상: mediaGrab.pendingVideos. 감시 중에 각 영상을 재생한 뒤 mediaGrab.export() 하세요.");
      return rows;
    }
  };
  window.mediaGrab.watch({ quiet: false });
})();
