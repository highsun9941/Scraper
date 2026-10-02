(() => {
  const found = new Map(), blockedFrames = new Set();
  const guess = u => {
    if (/\.gif(?:$|[?#])|^data:image\/gif[;,]/i.test(u)) return "GIF";
    if (/\.(?:m3u8|mpd)(?:$|[?#])/i.test(u)) return "STREAM";
    if (/\.(?:mp4|webm|m4v|mov|ogv|avi|mkv|mpg|mpeg)(?:$|[?#])|^data:video\//i.test(u)) return "VIDEO";
    if (/\.(?:jpe?g|png|webp|avif|svg|bmp|ico|apng|tiff?)(?:$|[?#])|^data:image\//i.test(u)) return "IMAGE";
    return "";
  };
  const add = (raw, kind, base, source) => {
    if (!raw || typeof raw !== "string" || !raw.trim()) return;
    try {
      const u = new URL(raw.trim(), base);
      if (!/^(?:https?:|blob:|data:)$/.test(u.protocol)) return;
      if (u.protocol === "data:" && !/^data:(?:image|video)\//i.test(u.href)) return;
      const type = guess(u.href) || kind;
      if (type) {
        const old = found.get(u.href);
        if (!old) found.set(u.href, { type, url: u.href, source, temporary: u.protocol === "blob:" });
        else if (old.type === "IMAGE" && type !== "IMAGE") Object.assign(old, { type, source });
      }
    } catch {}
  };
  // srcset의 URL 안에 쉼표가 들어 있어도 보존합니다.
  const srcset = (text, kind, base, source) => {
    let i = 0;
    while (i < text.length) {
      while (i < text.length && /[\s,]/.test(text[i])) i++;
      const start = i;
      while (i < text.length && !/\s/.test(text[i])) i++;
      const token = text.slice(start, i);
      if (!token) break;
      add(token.replace(/,+$/, ""), kind, base, source);
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
  const css = (text, base, source) => {
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
      add(raw, "IMAGE", base, source);
    }
  };
  const walk = (root, seen) => {
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
      const tag = el.localName, parent = el.parentElement?.localName;
      const base = el.baseURI || doc.baseURI;
      let kind = tag === "video" || (tag === "source" && parent === "video") ? "VIDEO" :
        ["img", "image"].includes(tag) || (tag === "source" && parent === "picture") ||
        (tag === "input" && el.type === "image") ? "IMAGE" : "";
      if (/^image\/gif$/i.test(el.getAttribute("type") || "")) kind = "GIF";
      if (["object", "embed"].includes(tag)) {
        const mime = el.getAttribute("type") || "";
        kind = /^image\/gif$/i.test(mime) ? "GIF" : /^image\//i.test(mime) ? "IMAGE" : /^video\//i.test(mime) ? "VIDEO" : kind;
        add(el.getAttribute("data") || el.getAttribute("src"), kind, base, tag);
      }
      if (kind) {
        add(el.currentSrc, kind, base, `${tag}.currentSrc`);
        for (const a of ["src", "data-src", "data-original", "data-lazy-src", "data-original-src", "data-url", "data-large"]) {
          add(el.getAttribute(a), kind, base, `${tag}.${a}`);
        }
        if (kind !== "VIDEO") for (const a of ["srcset", "data-srcset", "data-lazy-srcset"]) {
          srcset(el.getAttribute(a) || "", kind, base, `${tag}.${a}`);
        }
      }
      if (tag === "image") add(el.getAttribute("href") || el.getAttribute("xlink:href"), "IMAGE", base, "svg.image");
      if (tag === "video") add(el.getAttribute("poster"), "IMAGE", base, "video.poster");
      if (["a", "link"].includes(tag)) add(el.getAttribute("href"), "", base, `${tag}.href`);
      for (const a of ["data-bg", "data-background", "data-background-image", "data-image", "data-image-src", "data-video-src", "data-video-url", "data-poster"]) {
        const value = el.getAttribute(a);
        if (!value) continue;
        if (/url\(/i.test(value)) css(value, base, a);
        else if (/^(?:https?:|blob:|data:|\/|\.{1,2}\/)/i.test(value) || guess(value)) {
          add(value, a.includes("video") ? "VIDEO" : "IMAGE", base, a);
        }
      }
      for (const pseudo of [null, "::before", "::after"]) {
        try {
          const s = win.getComputedStyle(el, pseudo);
          for (const prop of ["background-image", "content", "border-image-source", "list-style-image", "mask-image", "-webkit-mask-image"]) {
            css(s.getPropertyValue(prop), base, `css${pseudo || ""}.${prop}`);
          }
        } catch {}
      }
      if (el.shadowRoot) walk(el.shadowRoot, seen);
      if (tag === "iframe") {
        try {
          if (el.contentDocument) walk(el.contentDocument, seen);
          else blockedFrames.add(el.src || "접근할 수 없는 iframe");
        } catch { blockedFrames.add(el.src || "접근할 수 없는 iframe"); }
      }
    }
  };
  window.mediaGrab = {
    get urls() { return [...found.keys()]; },
    get rows() { return [...found.values()]; },
    get blockedFrames() { return [...blockedFrames]; },
    scan() {
      walk(document, new Set());
      console.table(this.rows);
      console.log(`총 ${found.size}개 URL\n${this.urls.join("\n")}`);
      if (blockedFrames.size) console.log("접근할 수 없는 iframe:", this.blockedFrames);
      return this.rows;
    }
  };
  window.mediaGrab.scan();
})();
