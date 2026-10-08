(() => {
  // 스니펫을 다시 실행하면 이전 감시기를 해제합니다.
  try { window.mediaGrab?.stopWatching?.(); } catch {}
  const found = new Map(), excluded = new Map(), blockedFrames = new Set(), reviewPreviews = new Map();
  // 병합 도중 요청한 하위 목록·조각이 새 수집 항목으로 다시 들어오는 것을 막습니다.
  const downloadOnlyResources = new Set();
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
  const addResource = (r, base, doc = null) => {
    if (downloadOnlyResources.has(absolute(r.name, base))) return;
    const kind = r.initiatorType === "img" ? "IMAGE" : r.initiatorType === "video" ? "VIDEO" : "";
    add(r.name, kind, base, "network");
    if (r.initiatorType === "iframe") addEmbed(r.name, base, "network.iframe");
    if (doc) rememberReviewRequest(r.name, doc);
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
  // 리뷰 데이터에 실제로 들어 있는 URL만 읽습니다. 썸네일에서 MP4 경로를 만들지 않습니다.
  const reviewLimit = 2 * 1024 ** 2, reviewTasks = new Set(), reviewRequests = new Map(), reviewFetchers = new Map();
  const reviewErrors = new Map(), reviewLimits = new Set(), scriptTexts = new WeakMap();
  let reviewPropsVisited = new WeakSet(), reviewFibersVisited = new WeakSet();
  let reviewRun = null, reviewReady = Promise.resolve(), watchEpoch = 0;
  const ownValue = (object, key) => {
    try { return Object.getOwnPropertyDescriptor(object, key)?.value; } catch { return undefined; }
  };
  const reviewSource = (raw, base, source, hint = "") => {
    if (typeof raw !== "string" || raw.includes("\\")) return false;
    const href = absolute(raw, base);
    if (!href) return;
    try {
      const u = new URL(href), type = guess(href);
      if (!/^https?:$/.test(u.protocol) || u.hostname !== "video.coupangcdn.com" ||
          !/^\/cloud\/PRODUCTREVIEW\//i.test(u.pathname) ||
          /(?:thumbnail|poster)/i.test(u.pathname) || ["IMAGE", "GIF"].includes(type)) return;
      if (["VIDEO", "STREAM"].includes(type) || hint) { add(href, type || hint, base, source); return true; }
    } catch {}
  };
  const reviewText = (text, base, source) => {
    if (typeof text !== "string") return;
    if (text.length > reviewLimit) { reviewLimits.add(source); return; }
    // JSON/HTML에 보관된 슬래시·앰퍼샌드 표기만 해제하며 스크립트를 실행하지 않습니다.
    const decoded = text.replace(/\\u([\da-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\(?:x2f|\/)/gi, "/").replace(/\\x26/gi, "&")
      .replace(/&amp;|&#0*38;|&#x0*26;/gi, "&").replace(/&quot;|&#0*34;|&#x0*22;/gi, '"')
      .replace(/&apos;|&#0*39;|&#x0*27;/gi, "'");
    for (const m of decoded.matchAll(/(?:https?:)?\/\/video\.coupangcdn\.com\/cloud\/PRODUCTREVIEW\/[^\s"'<>\\)]+/gi)) {
      if (decoded[m.index + m[0].length] !== "\\") reviewSource(m[0], base, source);
    }
  };
  const reviewData = (data, base, source, win) => {
    const seen = new WeakSet(), stack = [{ value: data, depth: 0, hint: "" }];
    let count = 0;
    while (stack.length && count++ < 20000) {
      const { value, depth, hint } = stack.pop();
      if (typeof value === "string") {
        if (value.length <= 32768) {
          // JSON의 실제 URL 문자열에는 HTML 엔티티 변환을 적용하지 않습니다(서명 보존).
          if (!reviewSource(value, base, source, hint)) reviewText(value, base, source);
        }
        else reviewLimits.add(source);
        continue;
      }
      if (!value || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value);
      // DOM·React의 소유자 링크는 건너뛰며 getter와 함수는 실행하지 않습니다.
      if (value === win || value === win?.document || ownValue(value, "ownerDocument") ||
          typeof win?.Node === "function" && value instanceof win.Node) continue;
      if (depth >= 20) { reviewLimits.add(source); continue; }
      let keys;
      try { keys = Object.getOwnPropertyNames(value); } catch { continue; }
      const mime = ownValue(value, "mimeType") || ownValue(value, "contentType") || ownValue(value, "type");
      const mediaHint = typeof mime === "string" && /^(?:video\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml))/i.test(mime) ?
        (/mpegurl|dash\+xml/i.test(mime) ? "STREAM" : "VIDEO") : hint;
      const remaining = Math.max(0, 20000 - count - stack.length);
      if (keys.length > remaining) reviewLimits.add(source);
      for (const key of keys.slice(0, remaining).reverse()) {
        if (["__proto__", "constructor", "prototype", "_owner", "stateNode", "return", "sibling", "child", "alternate", "ref"].includes(key)) continue;
        const child = ownValue(value, key);
        if (child === undefined || typeof child === "function") continue;
        stack.push({ value: child, depth: depth + 1,
          hint: /^(?:videos?|video(?:url|src|source|sources|files?)|play(?:url|src)|stream(?:url|src))$/i.test(key.replace(/[_-]/g, "")) ? "VIDEO" : mediaHint });
      }
    }
    if (stack.length) reviewLimits.add(source);
  };
  const reviewPayload = (text, base, source, win) => {
    if (typeof text !== "string") return;
    if (text.length > reviewLimit) { reviewLimits.add(source); return; }
    try { reviewData(JSON.parse(text), base, source, win); }
    catch { reviewText(text, base, source); }
  };
  const captureReviewScript = (el, base, win) => {
    if (el?.localName !== "script") return;
    const text = el.textContent || "";
    if (!text || scriptTexts.get(el) === text) return;
    if (text.length > reviewLimit) { reviewLimits.add("review.script"); return; }
    scriptTexts.set(el, text);
    if (/^application\/(?:ld\+)?json$/i.test(el.getAttribute("type") || "") || el.getAttribute("id") === "__NEXT_DATA__") {
      reviewPayload(text, base, "review.script.json", win);
    } else reviewText(text, base, "review.script.url");
  };
  const captureReviewProps = (el, base, win) => {
    // 썸네일 주변의 데이터만 검사합니다. React 내부 필드가 없거나 바뀌면 건너뜁니다.
    for (let parent = el, level = 0; parent && level < 8; parent = parentOf(parent), level++) {
      if (reviewPropsVisited.has(parent)) continue;
      reviewPropsVisited.add(parent);
      for (const attr of ["data-review-media-original-src", "data-review-media-url", "data-video-src", "data-video-url", "data-review", "data-media", "data-props", "data-urls"]) {
        const value = parent.getAttribute?.(attr);
        if (value) {
          if (/video|media-original-src|media-url/.test(attr)) reviewSource(value, base, `review.${attr}`, "VIDEO");
          reviewPayload(value, base, `review.${attr}`, win);
        }
      }
      let keys;
      try { keys = Object.getOwnPropertyNames(parent); } catch { continue; }
      for (const key of keys) {
        if (key.startsWith("__reactProps$")) reviewData(ownValue(parent, key), base, "review.react.props", win);
        if (!/^(?:__reactFiber\$|__reactInternalInstance\$)/.test(key)) continue;
        for (let fiber = ownValue(parent, key), depth = 0; fiber && typeof fiber === "object" && depth < 12 && !reviewFibersVisited.has(fiber); depth++) {
          reviewFibersVisited.add(fiber);
          for (const field of ["memoizedProps", "pendingProps", "memoizedState"]) reviewData(ownValue(fiber, field), base, `review.react.${field}`, win);
          fiber = ownValue(fiber, "return");
        }
      }
    }
  };
  const linkReviewPositions = () => {
    for (const [key, thumbnail] of reviewPreviews) {
      const preview = found.get(thumbnail);
      if (!preview?.position) continue;
      for (const row of found.values()) {
        if (["VIDEO", "STREAM"].includes(row.type) && row.url.startsWith(key) && !row.position) {
          // 썸네일 옆에 정렬하지만, 영상이 표시됐다고 표기하지는 않습니다.
          row.position = { ...preview.position }; row.element = preview.element;
        }
      }
    }
  };
  const reviewEndpoint = (raw, doc) => {
    try {
      const u = new URL(raw, doc.baseURI), page = new URL(doc.URL || doc.baseURI);
      if (!/^https?:$/.test(u.protocol) || u.origin !== page.origin ||
          !/(?:^|\/)reviews?(?:\/|$)/i.test(u.pathname) ||
          /(?:^|\/)(?:create|write|save|delete|remove|report|vote|helpful|upload)(?:\/|$)/i.test(u.pathname)) return null;
      u.hash = "";
      return u;
    } catch { return null; }
  };
  const rememberReviewRequest = (raw, doc, method = null) => {
    const u = reviewEndpoint(raw, doc);
    if (!u) return;
    const old = reviewRequests.get(u.href);
    // 과거 Resource Timing에는 메서드가 없습니다. 쿠팡의 관찰된 리뷰 목록 경로만 GET 재조회 후보로 둡니다.
    const legacyList = /^(?:www\.)?coupang\.com$/i.test(u.hostname) && u.pathname === "/vp/product/reviews";
    reviewRequests.set(u.href, { url: u.href, doc, method: method ?? old?.method ?? (legacyList ? "GET" : ""),
      list: /\/(?:reviews?|reviews?\/(?:list|search))\/?$/i.test(u.pathname) });
  };
  const trackReviewTask = task => {
    reviewTasks.add(task);
    task.then(() => reviewTasks.delete(task), () => reviewTasks.delete(task));
    return task;
  };
  const waitReviewTasks = async () => {
    if (!reviewTasks.size) return;
    const completed = Promise.allSettled([...reviewTasks]);
    if (typeof window.setTimeout !== "function") { await completed; return; }
    let timer;
    try {
      // 페이지가 리뷰 요청을 끝내지 않아도 콘솔 명령이 무한정 대기하지 않게 합니다.
      await Promise.race([completed, new Promise(resolve => { timer = window.setTimeout(resolve, 8000); })]);
    } finally { window.clearTimeout?.(timer); }
  };
  const readReviewResponse = async (response, doc, source, epoch) => {
    if (!watching || epoch !== watchEpoch || !response?.ok) return;
    if (response.url && !reviewEndpoint(response.url, doc)) return;
    const mime = response.headers?.get("Content-Type") || "";
    if (!/(?:json|text\/(?:plain|html))/i.test(mime)) return;
    if (Number(response.headers?.get("Content-Length")) > reviewLimit) { reviewLimits.add(source); return; }
    const clone = response.clone();
    let text = "";
    if (clone.body?.getReader && typeof TextDecoder === "function") {
      const reader = clone.body.getReader(), decoder = new TextDecoder();
      const cancel = () => { reader.cancel().catch(() => {}); };
      cleanups.add(cancel);
      let bytes = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > reviewLimit) { reviewLimits.add(source); reader.cancel().catch(() => {}); return; }
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
      } finally { cleanups.delete(cancel); reader.releaseLock(); }
    } else {
      // 스트림 API가 없는 환경에서 크기 미상의 본문을 무제한 복제하지 않습니다.
      if (clone.body && !response.headers?.get("Content-Length")) { reviewLimits.add(source); return; }
      text = await clone.text();
    }
    if (watching && epoch === watchEpoch) {
      reviewPayload(text, doc.baseURI, source, doc.defaultView); linkReviewPositions();
    }
  };
  const observeReviewResponses = (win, doc) => {
    const epoch = watchEpoch;
    if (typeof win.fetch === "function") {
      const original = win.fetch;
      reviewFetchers.set(win, original);
      const wrapped = function (...args) {
        const promise = Reflect.apply(original, this, args);
        try {
          const input = args[0], request = typeof win.Request === "function" && input instanceof win.Request;
          const href = typeof input === "string" ? input : input instanceof URL ? input.href : request ? input.url : "";
          const fallback = request ? input.method : "GET";
          const descriptor = Object.getOwnPropertyDescriptor(Object(args[1]), "method");
          // accessor·상속된 method는 읽지 않고 미확인으로 둡니다. POST를 GET으로 추정하지 않습니다.
          const method = descriptor ? ("value" in descriptor ? String(descriptor.value === undefined ? fallback : descriptor.value).toUpperCase() : "") :
            args[1] && "method" in Object(args[1]) ? "" : fallback;
          if (watching && epoch === watchEpoch && reviewEndpoint(href, doc)) {
            rememberReviewRequest(href, doc, method);
            // 원래 Promise에 바로 연결해야 iframe 등 다른 realm에서도 페이지보다 먼저 clone할 수 있습니다.
            trackReviewTask(promise.then(response => readReviewResponse(response, doc, "review.fetch", epoch))
              .catch(error => reviewErrors.set(href, error.message)));
          }
        } catch {}
        return promise; // 페이지에는 원래 Promise·Response를 돌려주고 복제한 본문만 읽습니다.
      };
      try {
        win.fetch = wrapped;
        cleanups.add(() => { if (win.fetch === wrapped) win.fetch = original; reviewFetchers.delete(win); });
      } catch {}
    }
    const proto = win.XMLHttpRequest?.prototype;
    if (!proto?.open || !proto?.send) return;
    const originalOpen = proto.open, originalSend = proto.send, requests = new WeakMap();
    const open = function (...args) {
      const result = Reflect.apply(originalOpen, this, args);
      const href = absolute(typeof args[1] === "string" ? args[1] : args[1] instanceof URL ? args[1].href : "", doc.baseURI);
      requests.set(this, { href, method: typeof args[0] === "string" ? args[0].toUpperCase() : "" });
      return result;
    };
    const send = function (...args) {
      const request = requests.get(this);
      if (!watching || epoch !== watchEpoch || !request || !reviewEndpoint(request.href, doc)) return Reflect.apply(originalSend, this, args);
      rememberReviewRequest(request.href, doc, request.method);
      const xhr = this;
      const remove = () => { xhr.removeEventListener("loadend", loaded); cleanups.delete(remove); };
      const loaded = () => {
        remove();
        if (!watching || epoch !== watchEpoch || xhr.status < 200 || xhr.status >= 300 ||
            xhr.responseURL && !reviewEndpoint(xhr.responseURL, doc)) return;
        try {
          if (xhr.responseType === "json") reviewData(xhr.response, doc.baseURI, "review.xhr.json", win);
          else if (["", "text"].includes(xhr.responseType || "")) reviewPayload(xhr.responseText, doc.baseURI, "review.xhr", win);
          linkReviewPositions();
        } catch (error) { reviewErrors.set(request.href, error.message); }
      };
      xhr.addEventListener("loadend", loaded, { once: true }); cleanups.add(remove);
      try { return Reflect.apply(originalSend, this, args); } catch (error) { remove(); throw error; }
    };
    try {
      proto.open = open; proto.send = send;
      cleanups.add(() => { if (proto.open === open) proto.open = originalOpen; if (proto.send === send) proto.send = originalSend; });
    } catch {}
  };
  const refreshReviewResponses = () => {
    if (reviewRun) return reviewRun;
    const epoch = watchEpoch;
    const run = (async () => {
      const candidates = [...reviewRequests.values()].filter(r => r.list && r.method === "GET");
      if (candidates.length > 8) reviewLimits.add("review.requests");
      for (const r of candidates.slice(0, 8)) {
        const win = r.doc.defaultView;
        if (!watching || epoch !== watchEpoch) break;
        if (typeof win?.fetch !== "function" || typeof win.AbortController !== "function") continue;
        const controller = new win.AbortController(), abort = () => controller.abort();
        cleanups.add(abort);
        const timer = win.setTimeout?.(abort, 8000);
        try {
          const response = await Reflect.apply(reviewFetchers.get(win) || win.fetch, win,
            [r.url, { method: "GET", credentials: "same-origin", signal: controller.signal }]);
          if (!response.ok) throw new Error(`리뷰 목록 응답 HTTP ${response.status}`);
          await readReviewResponse(response, r.doc, "review.refresh", epoch);
          reviewErrors.delete(r.url);
        } catch (error) { reviewErrors.set(r.url, error.message); }
        finally { win.clearTimeout?.(timer); cleanups.delete(abort); }
      }
    })().finally(() => { if (reviewRun === run) reviewRun = null; });
    reviewRun = run;
    return run;
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
      let review = false;
      for (const raw of previewSources) {
        if (reviewKey(raw, base)) {
          review = true;
          rememberPreview(raw, base);
          add(raw, "IMAGE", base, "review.thumbnail", position,
            absolute(raw, base) === absolute(el.currentSrc || el.getAttribute("src"), base), element);
        }
      }
      if (review) captureReviewProps(el, base, win);
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
  const captureTree = (root, ctx, nested = false) => {
    styles = new WeakMap(); layouts = new WeakMap();
    if (!nested) { reviewPropsVisited = new WeakSet(); reviewFibersVisited = new WeakSet(); }
    if ((root?.ownerDocument || root) === document) {
      ctx = { ...ctx, x: Number(window.scrollX) || 0, y: Number(window.scrollY) || 0 };
    }
    captureMedia(root, ctx);
    const doc = root?.ownerDocument || root;
    captureReviewScript(root, doc?.baseURI, doc?.defaultView);
    for (const el of root?.querySelectorAll?.("video, video-js, .video-js, iframe, object, embed, img, script") || []) {
      captureMedia(el, ctx);
      captureReviewScript(el, el.baseURI || doc?.baseURI, doc?.defaultView);
      if (el.shadowRoot) captureTree(el.shadowRoot, ctx, true);
    }
    linkReviewPositions();
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
    observeReviewResponses(win, root.ownerDocument || root);
    try {
      if (typeof win.PerformanceObserver === "function") {
        const observer = new win.PerformanceObserver(list => {
          const doc = root.ownerDocument || root;
          if (watching) for (const resource of list.getEntries()) addResource(resource, doc.baseURI, doc);
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
      for (const r of resources) addResource(r, doc.baseURI, doc);
      for (const key of ["__NEXT_DATA__", "__INITIAL_STATE__", "__PRELOADED_STATE__", "__NUXT__"]) {
        reviewData(ownValue(win, key), doc.baseURI, `review.page.${key}`, win);
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
      captureMedia(el, ctx, element);
      captureReviewScript(el, base, win);
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
  const readMedia = async (url, options, signal, inspect = true) => {
    if (!found.has(url)) downloadOnlyResources.add(url);
    const controller = new AbortController(), abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(abort, options.timeoutMs);
    let response;
    try {
      response = await fetch(url, { mode: "cors", credentials: options.credentials, signal: controller.signal });
      if (response.url && !found.has(response.url)) downloadOnlyResources.add(response.url);
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
      const extension = inspect ? mediaExtension(prefix.subarray(0, prefixSize)) : null;
      if (inspect && !extension) throw new Error("지원하는 미디어 형식이 아닙니다. OK·HTML·JSON 또는 손상된 응답일 수 있습니다.");
      return { blob: new Blob(chunks), size, crc: (crc ^ 0xffffffff) >>> 0, extension,
        httpStatus: response.status, contentType: response.headers.get("Content-Type") || "",
        resolvedUrl: response.url || url };
    } catch (error) {
      const message = signal.aborted ? "사용자가 중단했습니다." : controller.signal.aborted ? "요청 대기 시간을 넘었습니다." :
        error?.name === "TypeError" ? `브라우저에서 응답을 읽지 못했습니다(CORS·CSP·접속 제한 등): ${error.message}` : error.message;
      const failure = new Error(message);
      failure.httpStatus = response?.status || ""; failure.contentType = response?.headers.get("Content-Type") || "";
      throw failure;
    } finally { clearTimeout(timer); controller.abort(); signal.removeEventListener("abort", abort); }
  };
  // mux.js의 MP4 전용 배포본을 포함합니다. 실행 시 CDN·Worker·WASM을 로딩하지 않습니다.
  // 버전·원본 체크섬·라이선스: THIRD-PARTY-NOTICES.md
  const createHlsMux = () => {
    const module = { exports: {} }, exports = module.exports;
    const require = name => {
      if (name !== "global/window") throw new Error("지원하지 않는 번들 의존성입니다.");
      return window;
    };
    /* BEGIN VENDORED MUX.JS */
/*! @name mux.js @version 6.3.0 @license Apache-2.0 */
!function(t,e){"object"==typeof exports&&"undefined"!=typeof module?module.exports=e(require("global/window")):"function"==typeof define&&define.amd?define(["global/window"],e):(t="undefined"!=typeof globalThis?globalThis:t||self).muxjs=e(t.window)}(this,(function(t){"use strict";function e(t){return t&&"object"==typeof t&&"default"in t?t:{default:t}}var i,n,a,r,s,o,d,h,p,u,l,c,f,g,m,y,S,v,b,_,w,T,C,k,P,A,U,D,E,L,x,O,I,R,M,N,B,W,G,z,F=e(t),V=Math.pow(2,32),Y={getUint64:function(t){var e,i=new DataView(t.buffer,t.byteOffset,t.byteLength);return i.getBigUint64?(e=i.getBigUint64(0))<Number.MAX_SAFE_INTEGER?Number(e):e:i.getUint32(0)*V+i.getUint32(4)},MAX_UINT32:V},X=Y.MAX_UINT32;!function(){var t;if(T={avc1:[],avcC:[],btrt:[],dinf:[],dref:[],esds:[],ftyp:[],hdlr:[],mdat:[],mdhd:[],mdia:[],mfhd:[],minf:[],moof:[],moov:[],mp4a:[],mvex:[],mvhd:[],pasp:[],sdtp:[],smhd:[],stbl:[],stco:[],stsc:[],stsd:[],stsz:[],stts:[],styp:[],tfdt:[],tfhd:[],traf:[],trak:[],trun:[],trex:[],tkhd:[],vmhd:[]},"undefined"!=typeof Uint8Array){for(t in T)T.hasOwnProperty(t)&&(T[t]=[t.charCodeAt(0),t.charCodeAt(1),t.charCodeAt(2),t.charCodeAt(3)]);C=new Uint8Array(["i".charCodeAt(0),"s".charCodeAt(0),"o".charCodeAt(0),"m".charCodeAt(0)]),P=new Uint8Array(["a".charCodeAt(0),"v".charCodeAt(0),"c".charCodeAt(0),"1".charCodeAt(0)]),k=new Uint8Array([0,0,0,1]),A=new Uint8Array([0,0,0,0,0,0,0,0,118,105,100,101,0,0,0,0,0,0,0,0,0,0,0,0,86,105,100,101,111,72,97,110,100,108,101,114,0]),U=new Uint8Array([0,0,0,0,0,0,0,0,115,111,117,110,0,0,0,0,0,0,0,0,0,0,0,0,83,111,117,110,100,72,97,110,100,108,101,114,0]),D={video:A,audio:U},x=new Uint8Array([0,0,0,0,0,0,0,1,0,0,0,12,117,114,108,32,0,0,0,1]),L=new Uint8Array([0,0,0,0,0,0,0,0]),O=new Uint8Array([0,0,0,0,0,0,0,0]),I=O,R=new Uint8Array([0,0,0,0,0,0,0,0,0,0,0,0]),M=O,E=new Uint8Array([0,0,0,1,0,0,0,0,0,0,0,0])}}(),i=function(t){var e,i,n=[],a=0;for(e=1;e<arguments.length;e++)n.push(arguments[e]);for(e=n.length;e--;)a+=n[e].byteLength;for(i=new Uint8Array(a+8),new DataView(i.buffer,i.byteOffset,i.byteLength).setUint32(0,i.byteLength),i.set(t,4),e=0,a=8;e<n.length;e++)i.set(n[e],a),a+=n[e].byteLength;return i},n=function(){return i(T.dinf,i(T.dref,x))},a=function(t){return i(T.esds,new Uint8Array([0,0,0,0,3,25,0,0,0,4,17,64,21,0,6,0,0,0,218,192,0,0,218,192,5,2,t.audioobjecttype<<3|t.samplingfrequencyindex>>>1,t.samplingfrequencyindex<<7|t.channelcount<<3,6,1,2]))},m=function(t){return i(T.hdlr,D[t])},g=function(t){var e=new Uint8Array([0,0,0,0,0,0,0,2,0,0,0,3,0,1,95,144,t.duration>>>24&255,t.duration>>>16&255,t.duration>>>8&255,255&t.duration,85,196,0,0]);return t.samplerate&&(e[12]=t.samplerate>>>24&255,e[13]=t.samplerate>>>16&255,e[14]=t.samplerate>>>8&255,e[15]=255&t.samplerate),i(T.mdhd,e)},f=function(t){return i(T.mdia,g(t),m(t.type),o(t))},s=function(t){return i(T.mfhd,new Uint8Array([0,0,0,0,(4278190080&t)>>24,(16711680&t)>>16,(65280&t)>>8,255&t]))},o=function(t){return i(T.minf,"video"===t.type?i(T.vmhd,E):i(T.smhd,L),n(),S(t))},d=function(t,e){for(var n=[],a=e.length;a--;)n[a]=b(e[a]);return i.apply(null,[T.moof,s(t)].concat(n))},h=function(t){for(var e=t.length,n=[];e--;)n[e]=l(t[e]);return i.apply(null,[T.moov,u(4294967295)].concat(n).concat(p(t)))},p=function(t){for(var e=t.length,n=[];e--;)n[e]=_(t[e]);return i.apply(null,[T.mvex].concat(n))},u=function(t){var e=new Uint8Array([0,0,0,0,0,0,0,1,0,0,0,2,0,1,95,144,(4278190080&t)>>24,(16711680&t)>>16,(65280&t)>>8,255&t,0,1,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,64,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,255,255,255,255]);return i(T.mvhd,e)},y=function(t){var e,n,a=t.samples||[],r=new Uint8Array(4+a.length);for(n=0;n<a.length;n++)e=a[n].flags,r[n+4]=e.dependsOn<<4|e.isDependedOn<<2|e.hasRedundancy;return i(T.sdtp,r)},S=function(t){return i(T.stbl,v(t),i(T.stts,M),i(T.stsc,I),i(T.stsz,R),i(T.stco,O))},v=function(t){return i(T.stsd,new Uint8Array([0,0,0,0,0,0,0,1]),"video"===t.type?N(t):B(t))},N=function(t){var e,n,a=t.sps||[],r=t.pps||[],s=[],o=[];for(e=0;e<a.length;e++)s.push((65280&a[e].byteLength)>>>8),s.push(255&a[e].byteLength),s=s.concat(Array.prototype.slice.call(a[e]));for(e=0;e<r.length;e++)o.push((65280&r[e].byteLength)>>>8),o.push(255&r[e].byteLength),o=o.concat(Array.prototype.slice.call(r[e]));if(n=[T.avc1,new Uint8Array([0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,(65280&t.width)>>8,255&t.width,(65280&t.height)>>8,255&t.height,0,72,0,0,0,72,0,0,0,0,0,0,0,1,19,118,105,100,101,111,106,115,45,99,111,110,116,114,105,98,45,104,108,115,0,0,0,0,0,0,0,0,0,0,0,0,0,24,17,17]),i(T.avcC,new Uint8Array([1,t.profileIdc,t.profileCompatibility,t.levelIdc,255].concat([a.length],s,[r.length],o))),i(T.btrt,new Uint8Array([0,28,156,128,0,45,198,192,0,45,198,192]))],t.sarRatio){var d=t.sarRatio[0],h=t.sarRatio[1];n.push(i(T.pasp,new Uint8Array([(4278190080&d)>>24,(16711680&d)>>16,(65280&d)>>8,255&d,(4278190080&h)>>24,(16711680&h)>>16,(65280&h)>>8,255&h])))}return i.apply(null,n)},B=function(t){return i(T.mp4a,new Uint8Array([0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,(65280&t.channelcount)>>8,255&t.channelcount,(65280&t.samplesize)>>8,255&t.samplesize,0,0,0,0,(65280&t.samplerate)>>8,255&t.samplerate,0,0]),a(t))},c=function(t){var e=new Uint8Array([0,0,0,7,0,0,0,0,0,0,0,0,(4278190080&t.id)>>24,(16711680&t.id)>>16,(65280&t.id)>>8,255&t.id,0,0,0,0,(4278190080&t.duration)>>24,(16711680&t.duration)>>16,(65280&t.duration)>>8,255&t.duration,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,64,0,0,0,(65280&t.width)>>8,255&t.width,0,0,(65280&t.height)>>8,255&t.height,0,0]);return i(T.tkhd,e)},b=function(t){var e,n,a,r,s,o;return e=i(T.tfhd,new Uint8Array([0,0,0,58,(4278190080&t.id)>>24,(16711680&t.id)>>16,(65280&t.id)>>8,255&t.id,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0])),s=Math.floor(t.baseMediaDecodeTime/X),o=Math.floor(t.baseMediaDecodeTime%X),n=i(T.tfdt,new Uint8Array([1,0,0,0,s>>>24&255,s>>>16&255,s>>>8&255,255&s,o>>>24&255,o>>>16&255,o>>>8&255,255&o])),92,"audio"===t.type?(a=w(t,92),i(T.traf,e,n,a)):(r=y(t),a=w(t,r.length+92),i(T.traf,e,n,a,r))},l=function(t){return t.duration=t.duration||4294967295,i(T.trak,c(t),f(t))},_=function(t){var e=new Uint8Array([0,0,0,0,(4278190080&t.id)>>24,(16711680&t.id)>>16,(65280&t.id)>>8,255&t.id,0,0,0,1,0,0,0,0,0,0,0,0,0,1,0,1]);return"video"!==t.type&&(e[e.length-1]=0),i(T.trex,e)},z=function(t,e){var i=0,n=0,a=0,r=0;return t.length&&(void 0!==t[0].duration&&(i=1),void 0!==t[0].size&&(n=2),void 0!==t[0].flags&&(a=4),void 0!==t[0].compositionTimeOffset&&(r=8)),[0,0,i|n|a|r,1,(4278190080&t.length)>>>24,(16711680&t.length)>>>16,(65280&t.length)>>>8,255&t.length,(4278190080&e)>>>24,(16711680&e)>>>16,(65280&e)>>>8,255&e]},G=function(t,e){var n,a,r,s,o,d;for(e+=20+16*(s=t.samples||[]).length,r=z(s,e),(a=new Uint8Array(r.length+16*s.length)).set(r),n=r.length,d=0;d<s.length;d++)o=s[d],a[n++]=(4278190080&o.duration)>>>24,a[n++]=(16711680&o.duration)>>>16,a[n++]=(65280&o.duration)>>>8,a[n++]=255&o.duration,a[n++]=(4278190080&o.size)>>>24,a[n++]=(16711680&o.size)>>>16,a[n++]=(65280&o.size)>>>8,a[n++]=255&o.size,a[n++]=o.flags.isLeading<<2|o.flags.dependsOn,a[n++]=o.flags.isDependedOn<<6|o.flags.hasRedundancy<<4|o.flags.paddingValue<<1|o.flags.isNonSyncSample,a[n++]=61440&o.flags.degradationPriority,a[n++]=15&o.flags.degradationPriority,a[n++]=(4278190080&o.compositionTimeOffset)>>>24,a[n++]=(16711680&o.compositionTimeOffset)>>>16,a[n++]=(65280&o.compositionTimeOffset)>>>8,a[n++]=255&o.compositionTimeOffset;return i(T.trun,a)},W=function(t,e){var n,a,r,s,o,d;for(e+=20+8*(s=t.samples||[]).length,r=z(s,e),(n=new Uint8Array(r.length+8*s.length)).set(r),a=r.length,d=0;d<s.length;d++)o=s[d],n[a++]=(4278190080&o.duration)>>>24,n[a++]=(16711680&o.duration)>>>16,n[a++]=(65280&o.duration)>>>8,n[a++]=255&o.duration,n[a++]=(4278190080&o.size)>>>24,n[a++]=(16711680&o.size)>>>16,n[a++]=(65280&o.size)>>>8,n[a++]=255&o.size;return i(T.trun,n)},w=function(t,e){return"audio"===t.type?W(t,e):G(t,e)};var j,q,H,$,Z,K,J,Q={ftyp:r=function(){return i(T.ftyp,C,k,C,P)},mdat:function(t){return i(T.mdat,t)},moof:d,moov:h,initSegment:function(t){var e,i=r(),n=h(t);return(e=new Uint8Array(i.byteLength+n.byteLength)).set(i),e.set(n,i.byteLength),e}},tt=function(t){return t>>>0},et=function(t){var e="";return e+=String.fromCharCode(t[0]),e+=String.fromCharCode(t[1]),e+=String.fromCharCode(t[2]),e+=String.fromCharCode(t[3])},it=tt,nt=function t(e,i){var n,a,r,s,o,d=[];if(!i.length)return null;for(n=0;n<e.byteLength;)a=it(e[n]<<24|e[n+1]<<16|e[n+2]<<8|e[n+3]),r=et(e.subarray(n+4,n+8)),s=a>1?n+a:e.byteLength,r===i[0]&&(1===i.length?d.push(e.subarray(n+8,s)):(o=t(e.subarray(n+8,s),i.slice(1))).length&&(d=d.concat(o))),n=s;return d},at=function(t){for(var e=0,i=String.fromCharCode(t[e]),n="";"\0"!==i;)n+=i,e++,i=String.fromCharCode(t[e]);return n+=i},rt=Y.getUint64,st=function(t,e){var i="\0"!==e.scheme_id_uri,n=0===t&&ot(e.presentation_time_delta)&&i,a=1===t&&ot(e.presentation_time)&&i;return!(t>1)&&n||a},ot=function(t){return void 0!==t||null!==t},dt=function(t){var e,i,n,a,r,s,o,d=4,h=t[0];if(0===h)d+=(e=at(t.subarray(d))).length,d+=(i=at(t.subarray(d))).length,n=(p=new DataView(t.buffer)).getUint32(d),d+=4,r=p.getUint32(d),d+=4,s=p.getUint32(d),d+=4,o=p.getUint32(d),d+=4;else if(1===h){var p;n=(p=new DataView(t.buffer)).getUint32(d),d+=4,a=rt(t.subarray(d)),d+=8,s=p.getUint32(d),d+=4,o=p.getUint32(d),d+=4,d+=(e=at(t.subarray(d))).length,d+=(i=at(t.subarray(d))).length}var u={scheme_id_uri:e,value:i,timescale:n||1,presentation_time:a,presentation_time_delta:r,event_duration:s,id:o,message_data:new Uint8Array(t.subarray(d,t.byteLength))};return st(h,u)?u:void 0},ht=function(t,e,i,n){return t||0===t?t/e:n+i/e},pt=function(t){var e,i=new DataView(t.buffer,t.byteOffset,t.byteLength),n={version:t[0],flags:new Uint8Array(t.subarray(1,4)),trackId:i.getUint32(4)},a=1&n.flags[2],r=2&n.flags[2],s=8&n.flags[2],o=16&n.flags[2],d=32&n.flags[2],h=65536&n.flags[0],p=131072&n.flags[0];return e=8,a&&(e+=4,n.baseDataOffset=i.getUint32(12),e+=4),r&&(n.sampleDescriptionIndex=i.getUint32(e),e+=4),s&&(n.defaultSampleDuration=i.getUint32(e),e+=4),o&&(n.defaultSampleSize=i.getUint32(e),e+=4),d&&(n.defaultSampleFlags=i.getUint32(e)),h&&(n.durationIsEmpty=!0),!a&&p&&(n.baseDataOffsetIsMoof=!0),n},ut=function(t){return{isLeading:(12&t[0])>>>2,dependsOn:3&t[0],isDependedOn:(192&t[1])>>>6,hasRedundancy:(48&t[1])>>>4,paddingValue:(14&t[1])>>>1,isNonSyncSample:1&t[1],degradationPriority:t[2]<<8|t[3]}},lt=function(t){var e,i={version:t[0],flags:new Uint8Array(t.subarray(1,4)),samples:[]},n=new DataView(t.buffer,t.byteOffset,t.byteLength),a=1&i.flags[2],r=4&i.flags[2],s=1&i.flags[1],o=2&i.flags[1],d=4&i.flags[1],h=8&i.flags[1],p=n.getUint32(4),u=8;for(a&&(i.dataOffset=n.getInt32(u),u+=4),r&&p&&(e={flags:ut(t.subarray(u,u+4))},u+=4,s&&(e.duration=n.getUint32(u),u+=4),o&&(e.size=n.getUint32(u),u+=4),h&&(1===i.version?e.compositionTimeOffset=n.getInt32(u):e.compositionTimeOffset=n.getUint32(u),u+=4),i.samples.push(e),p--);p--;)e={},s&&(e.duration=n.getUint32(u),u+=4),o&&(e.size=n.getUint32(u),u+=4),d&&(e.flags=ut(t.subarray(u,u+4)),u+=4),h&&(1===i.version?e.compositionTimeOffset=n.getInt32(u):e.compositionTimeOffset=n.getUint32(u),u+=4),i.samples.push(e);return i},ct=tt,ft=Y.getUint64,gt=function(t){var e={version:t[0],flags:new Uint8Array(t.subarray(1,4))};return 1===e.version?e.baseMediaDecodeTime=ft(t.subarray(4)):e.baseMediaDecodeTime=ct(t[4]<<24|t[5]<<16|t[6]<<8|t[7]),e},mt=function(t,e,i){if(!t)return-1;for(var n=i;n<t.length;n++)if(t[n]===e)return n;return-1},yt=3,St=function(t,e,i){var n,a="";for(n=e;n<i;n++)a+="%"+("00"+t[n].toString(16)).slice(-2);return a},vt=function(t,e,i){return decodeURIComponent(St(t,e,i))},bt=function(t,e,i){return unescape(St(t,e,i))},_t=function(t){return t[0]<<21|t[1]<<14|t[2]<<7|t[3]},wt={APIC:function(t){var e,i,n=1;t.data[0]===yt&&((e=mt(t.data,0,n))<0||(t.mimeType=bt(t.data,n,e),n=e+1,t.pictureType=t.data[n],n++,(i=mt(t.data,0,n))<0||(t.description=vt(t.data,n,i),n=i+1,"--\x3e"===t.mimeType?t.url=bt(t.data,n,t.data.length):t.pictureData=t.data.subarray(n,t.data.length))))},"T*":function(t){t.data[0]===yt&&(t.value=vt(t.data,1,t.data.length).replace(/\0*$/,""),t.values=t.value.split("\0"))},TXXX:function(t){var e;t.data[0]===yt&&-1!==(e=mt(t.data,0,1))&&(t.description=vt(t.data,1,e),t.value=vt(t.data,e+1,t.data.length).replace(/\0*$/,""),t.data=t.value)},"W*":function(t){t.url=bt(t.data,0,t.data.length).replace(/\0.*$/,"")},WXXX:function(t){var e;t.data[0]===yt&&-1!==(e=mt(t.data,0,1))&&(t.description=vt(t.data,1,e),t.url=bt(t.data,e+1,t.data.length).replace(/\0.*$/,""))},PRIV:function(t){var e;for(e=0;e<t.data.length;e++)if(0===t.data[e]){t.owner=bt(t.data,0,e);break}t.privateData=t.data.subarray(e+1),t.data=t.privateData}},Tt={parseId3Frames:function(t){var e,i=10,n=0,a=[];if(!(t.length<10||t[0]!=="I".charCodeAt(0)||t[1]!=="D".charCodeAt(0)||t[2]!=="3".charCodeAt(0))){n=_t(t.subarray(6,10)),n+=10,64&t[5]&&(i+=4,i+=_t(t.subarray(10,14)),n-=_t(t.subarray(16,20)));do{if((e=_t(t.subarray(i+4,i+8)))<1)break;var r={id:String.fromCharCode(t[i],t[i+1],t[i+2],t[i+3]),data:t.subarray(i+10,i+e+10)};r.key=r.id,wt[r.id]?wt[r.id](r):"T"===r.id[0]?wt["T*"](r):"W"===r.id[0]&&wt["W*"](r),a.push(r),i+=10,i+=e}while(i<n);return a}},parseSyncSafeInteger:_t,frameParsers:wt},Ct=tt,kt=function(t){return("00"+t.toString(16)).slice(-2)},Pt=Y.getUint64,At=Tt.parseId3Frames;j=function(t){return nt(t,["moov","trak"]).reduce((function(t,e){var i,n,a,r,s;return(i=nt(e,["tkhd"])[0])?(n=i[0],r=Ct(i[a=0===n?12:20]<<24|i[a+1]<<16|i[a+2]<<8|i[a+3]),(s=nt(e,["mdia","mdhd"])[0])?(a=0===(n=s[0])?12:20,t[r]=Ct(s[a]<<24|s[a+1]<<16|s[a+2]<<8|s[a+3]),t):null):null}),{})},q=function(t,e){var i=nt(e,["moof","traf"]).reduce((function(e,i){var n,a,r=nt(i,["tfhd"])[0],s=Ct(r[4]<<24|r[5]<<16|r[6]<<8|r[7]),o=t[s]||9e4,d=nt(i,["tfdt"])[0],h=new DataView(d.buffer,d.byteOffset,d.byteLength);return"bigint"==typeof(n=1===d[0]?Pt(d.subarray(4,12)):h.getUint32(4))?a=n/F.default.BigInt(o):"number"!=typeof n||isNaN(n)||(a=n/o),a<Number.MAX_SAFE_INTEGER&&(a=Number(a)),a<e&&(e=a),e}),1/0);return"bigint"==typeof i||isFinite(i)?i:0},H=function(t,e){var i,n=nt(e,["moof","traf"]),a=0,r=0;if(n&&n.length){var s=nt(n[0],["tfhd"])[0],o=nt(n[0],["trun"])[0],d=nt(n[0],["tfdt"])[0];if(s)i=pt(s).trackId;if(d)a=gt(d).baseMediaDecodeTime;if(o){var h=lt(o);h.samples&&h.samples.length&&(r=h.samples[0].compositionTimeOffset||0)}}var p=t[i]||9e4;"bigint"==typeof a&&(r=F.default.BigInt(r),p=F.default.BigInt(p));var u=(a+r)/p;return"bigint"==typeof u&&u<Number.MAX_SAFE_INTEGER&&(u=Number(u)),u},$=function(t){var e=nt(t,["moov","trak"]),i=[];return e.forEach((function(t){var e=nt(t,["mdia","hdlr"]),n=nt(t,["tkhd"]);e.forEach((function(t,e){var a,r,s=et(t.subarray(8,12)),o=n[e];"vide"===s&&(r=0===(a=new DataView(o.buffer,o.byteOffset,o.byteLength)).getUint8(0)?a.getUint32(12):a.getUint32(20),i.push(r))}))})),i},Z=function(t){var e=nt(t,["moov","trak"]),i=[];return e.forEach((function(t){var e,n,a={},r=nt(t,["tkhd"])[0];r&&(n=(e=new DataView(r.buffer,r.byteOffset,r.byteLength)).getUint8(0),a.id=0===n?e.getUint32(12):e.getUint32(20));var s=nt(t,["mdia","hdlr"])[0];if(s){var o=et(s.subarray(8,12));a.type="vide"===o?"video":"soun"===o?"audio":o}var d=nt(t,["mdia","minf","stbl","stsd"])[0];if(d){var h=d.subarray(8);a.codec=et(h.subarray(4,8));var p,u=nt(h,[a.codec])[0];u&&(/^[asm]vc[1-9]$/i.test(a.codec)?(p=u.subarray(78),"avcC"===et(p.subarray(4,8))&&p.length>11?(a.codec+=".",a.codec+=kt(p[9]),a.codec+=kt(p[10]),a.codec+=kt(p[11])):a.codec="avc1.4d400d"):/^mp4[a,v]$/i.test(a.codec)?(p=u.subarray(28),"esds"===et(p.subarray(4,8))&&p.length>20&&0!==p[19]?(a.codec+="."+kt(p[19]),a.codec+="."+kt(p[20]>>>2&63).replace(/^0/,"")):a.codec="mp4a.40.2"):a.codec=a.codec.toLowerCase())}var l=nt(t,["mdia","mdhd"])[0];l&&(a.timescale=K(l)),i.push(a)})),i},J=function(t,e){return void 0===e&&(e=0),nt(t,["emsg"]).map((function(t){var i=dt(new Uint8Array(t)),n=At(i.message_data);return{cueTime:ht(i.presentation_time,i.timescale,i.presentation_time_delta,e),duration:ht(i.event_duration,i.timescale),frames:n}}))};var Ut={findBox:nt,parseType:et,timescale:j,startTime:q,compositionStartTime:H,videoTrackIds:$,tracks:Z,getTimescaleFromMediaHeader:K=function(t){var e=0===t[0]?12:20;return Ct(t[e]<<24|t[e+1]<<16|t[e+2]<<8|t[e+3])},getEmsgID3:J},Dt=function(){this.init=function(){var t={};this.on=function(e,i){t[e]||(t[e]=[]),t[e]=t[e].concat(i)},this.off=function(e,i){var n;return!!t[e]&&(n=t[e].indexOf(i),t[e]=t[e].slice(),t[e].splice(n,1),n>-1)},this.trigger=function(e){var i,n,a,r;if(i=t[e])if(2===arguments.length)for(a=i.length,n=0;n<a;++n)i[n].call(this,arguments[1]);else{for(r=[],n=arguments.length,n=1;n<arguments.length;++n)r.push(arguments[n]);for(a=i.length,n=0;n<a;++n)i[n].apply(this,r)}},this.dispose=function(){t={}}}};Dt.prototype.pipe=function(t){return this.on("data",(function(e){t.push(e)})),this.on("done",(function(e){t.flush(e)})),this.on("partialdone",(function(e){t.partialFlush(e)})),this.on("endedtimeline",(function(e){t.endTimeline(e)})),this.on("reset",(function(e){t.reset(e)})),t},Dt.prototype.push=function(t){this.trigger("data",t)},Dt.prototype.flush=function(t){this.trigger("done",t)},Dt.prototype.partialFlush=function(t){this.trigger("partialdone",t)},Dt.prototype.endTimeline=function(t){this.trigger("endedtimeline",t)},Dt.prototype.reset=function(t){this.trigger("reset",t)};var Et,Lt,xt,Ot,It,Rt,Mt,Nt,Bt=Dt,Wt=function(t,e){var i={size:0,flags:{isLeading:0,dependsOn:1,isDependedOn:0,hasRedundancy:0,degradationPriority:0,isNonSyncSample:1}};return i.dataOffset=e,i.compositionTimeOffset=t.pts-t.dts,i.duration=t.duration,i.size=4*t.length,i.size+=t.byteLength,t.keyFrame&&(i.flags.dependsOn=2,i.flags.isNonSyncSample=0),i},Gt=function(t){var e,i,n=[],a=[];for(a.byteLength=0,a.nalCount=0,a.duration=0,n.byteLength=0,e=0;e<t.length;e++)"access_unit_delimiter_rbsp"===(i=t[e]).nalUnitType?(n.length&&(n.duration=i.dts-n.dts,a.byteLength+=n.byteLength,a.nalCount+=n.length,a.duration+=n.duration,a.push(n)),(n=[i]).byteLength=i.data.byteLength,n.pts=i.pts,n.dts=i.dts):("slice_layer_without_partitioning_rbsp_idr"===i.nalUnitType&&(n.keyFrame=!0),n.duration=i.dts-n.dts,n.byteLength+=i.data.byteLength,n.push(i));return a.length&&(!n.duration||n.duration<=0)&&(n.duration=a[a.length-1].duration),a.byteLength+=n.byteLength,a.nalCount+=n.length,a.duration+=n.duration,a.push(n),a},zt=function(t){var e,i,n=[],a=[];for(n.byteLength=0,n.nalCount=0,n.duration=0,n.pts=t[0].pts,n.dts=t[0].dts,a.byteLength=0,a.nalCount=0,a.duration=0,a.pts=t[0].pts,a.dts=t[0].dts,e=0;e<t.length;e++)(i=t[e]).keyFrame?(n.length&&(a.push(n),a.byteLength+=n.byteLength,a.nalCount+=n.nalCount,a.duration+=n.duration),(n=[i]).nalCount=i.length,n.byteLength=i.byteLength,n.pts=i.pts,n.dts=i.dts,n.duration=i.duration):(n.duration+=i.duration,n.nalCount+=i.length,n.byteLength+=i.byteLength,n.push(i));return a.length&&n.duration<=0&&(n.duration=a[a.length-1].duration),a.byteLength+=n.byteLength,a.nalCount+=n.nalCount,a.duration+=n.duration,a.push(n),a},Ft=function(t){var e;return!t[0][0].keyFrame&&t.length>1&&(e=t.shift(),t.byteLength-=e.byteLength,t.nalCount-=e.nalCount,t[0][0].dts=e.dts,t[0][0].pts=e.pts,t[0][0].duration+=e.duration),t},Vt=function(t,e){var i,n,a,r,s,o=e||0,d=[];for(i=0;i<t.length;i++)for(r=t[i],n=0;n<r.length;n++)s=r[n],o+=(a=Wt(s,o)).size,d.push(a);return d},Yt=function(t){var e,i,n,a,r,s,o=0,d=t.byteLength,h=t.nalCount,p=new Uint8Array(d+4*h),u=new DataView(p.buffer);for(e=0;e<t.length;e++)for(a=t[e],i=0;i<a.length;i++)for(r=a[i],n=0;n<r.length;n++)s=r[n],u.setUint32(o,s.data.byteLength),o+=4,p.set(s.data,o),o+=s.data.byteLength;return p},Xt=[33,16,5,32,164,27],jt=[33,65,108,84,1,2,4,8,168,2,4,8,17,191,252],qt=function(t){for(var e=[];t--;)e.push(0);return e},Ht=function(){if(!Et){var t={96e3:[Xt,[227,64],qt(154),[56]],88200:[Xt,[231],qt(170),[56]],64e3:[Xt,[248,192],qt(240),[56]],48e3:[Xt,[255,192],qt(268),[55,148,128],qt(54),[112]],44100:[Xt,[255,192],qt(268),[55,163,128],qt(84),[112]],32e3:[Xt,[255,192],qt(268),[55,234],qt(226),[112]],24e3:[Xt,[255,192],qt(268),[55,255,128],qt(268),[111,112],qt(126),[224]],16e3:[Xt,[255,192],qt(268),[55,255,128],qt(268),[111,255],qt(269),[223,108],qt(195),[1,192]],12e3:[jt,qt(268),[3,127,248],qt(268),[6,255,240],qt(268),[13,255,224],qt(268),[27,253,128],qt(259),[56]],11025:[jt,qt(268),[3,127,248],qt(268),[6,255,240],qt(268),[13,255,224],qt(268),[27,255,192],qt(268),[55,175,128],qt(108),[112]],8e3:[jt,qt(268),[3,121,16],qt(47),[7]]};e=t,Et=Object.keys(e).reduce((function(t,i){return t[i]=new Uint8Array(e[i].reduce((function(t,e){return t.concat(e)}),[])),t}),{})}var e;return Et},$t=9e4;Rt=function(t,e){return Lt(It(t,e))},Mt=function(t,e){return xt(Ot(t),e)},Nt=function(t,e,i){return Ot(i?t:t-e)};var Zt=$t,Kt=(Lt=function(t){return t*$t},xt=function(t,e){return t*e},Ot=function(t){return t/$t},It=function(t,e){return t/e},Rt),Jt=Mt,Qt=Nt,te=function(t,e,i,n){var a,r,s,o,d,h=0,p=0,u=0;if(e.length&&(a=Kt(t.baseMediaDecodeTime,t.samplerate),r=Math.ceil(Zt/(t.samplerate/1024)),i&&n&&(h=a-Math.max(i,n),u=(p=Math.floor(h/r))*r),!(p<1||u>Zt/2))){for((s=Ht()[t.samplerate])||(s=e[0].data),o=0;o<p;o++)d=e[0],e.splice(0,0,{data:s,dts:d.dts-r,pts:d.pts-r});return t.baseMediaDecodeTime-=Math.floor(Jt(u,t.samplerate)),u}},ee=function(t,e,i){return e.minSegmentDts>=i?t:(e.minSegmentDts=1/0,t.filter((function(t){return t.dts>=i&&(e.minSegmentDts=Math.min(e.minSegmentDts,t.dts),e.minSegmentPts=e.minSegmentDts,!0)})))},ie=function(t){var e,i,n=[];for(e=0;e<t.length;e++)i=t[e],n.push({size:i.data.byteLength,duration:1024});return n},ne=function(t){var e,i,n=0,a=new Uint8Array(function(t){var e,i=0;for(e=0;e<t.length;e++)i+=t[e].data.byteLength;return i}(t));for(e=0;e<t.length;e++)i=t[e],a.set(i.data,n),n+=i.data.byteLength;return a},ae=Zt,re=function(t){delete t.minSegmentDts,delete t.maxSegmentDts,delete t.minSegmentPts,delete t.maxSegmentPts},se=function(t,e){var i,n=t.minSegmentDts;return e||(n-=t.timelineStartInfo.dts),i=t.timelineStartInfo.baseMediaDecodeTime,i+=n,i=Math.max(0,i),"audio"===t.type&&(i*=t.samplerate/ae,i=Math.floor(i)),i},oe=function(t,e){"number"==typeof e.pts&&(void 0===t.timelineStartInfo.pts&&(t.timelineStartInfo.pts=e.pts),void 0===t.minSegmentPts?t.minSegmentPts=e.pts:t.minSegmentPts=Math.min(t.minSegmentPts,e.pts),void 0===t.maxSegmentPts?t.maxSegmentPts=e.pts:t.maxSegmentPts=Math.max(t.maxSegmentPts,e.pts)),"number"==typeof e.dts&&(void 0===t.timelineStartInfo.dts&&(t.timelineStartInfo.dts=e.dts),void 0===t.minSegmentDts?t.minSegmentDts=e.dts:t.minSegmentDts=Math.min(t.minSegmentDts,e.dts),void 0===t.maxSegmentDts?t.maxSegmentDts=e.dts:t.maxSegmentDts=Math.max(t.maxSegmentDts,e.dts))},de=function(t){for(var e=0,i={payloadType:-1,payloadSize:0},n=0,a=0;e<t.byteLength&&128!==t[e];){for(;255===t[e];)n+=255,e++;for(n+=t[e++];255===t[e];)a+=255,e++;if(a+=t[e++],!i.payload&&4===n){if("GA94"===String.fromCharCode(t[e+3],t[e+4],t[e+5],t[e+6])){i.payloadType=n,i.payloadSize=a,i.payload=t.subarray(e,e+a);break}i.payload=void 0}e+=a,n=0,a=0}return i},he=function(t){return 181!==t.payload[0]||49!=(t.payload[1]<<8|t.payload[2])||"GA94"!==String.fromCharCode(t.payload[3],t.payload[4],t.payload[5],t.payload[6])||3!==t.payload[7]?null:t.payload.subarray(8,t.payload.length-1)},pe=function(t,e){var i,n,a,r,s=[];if(!(64&e[0]))return s;for(n=31&e[0],i=0;i<n;i++)r={type:3&e[(a=3*i)+2],pts:t},4&e[a+2]&&(r.ccData=e[a+3]<<8|e[a+4],s.push(r));return s},ue=function(t){for(var e,i,n=t.byteLength,a=[],r=1;r<n-2;)0===t[r]&&0===t[r+1]&&3===t[r+2]?(a.push(r+2),r+=2):r++;if(0===a.length)return t;e=n-a.length,i=new Uint8Array(e);var s=0;for(r=0;r<e;s++,r++)s===a[0]&&(s++,a.shift()),i[r]=t[s];return i},le=4,ce=function t(e){e=e||{},t.prototype.init.call(this),this.parse708captions_="boolean"!=typeof e.parse708captions||e.parse708captions,this.captionPackets_=[],this.ccStreams_=[new Te(0,0),new Te(0,1),new Te(1,0),new Te(1,1)],this.parse708captions_&&(this.cc708Stream_=new Se({captionServices:e.captionServices})),this.reset(),this.ccStreams_.forEach((function(t){t.on("data",this.trigger.bind(this,"data")),t.on("partialdone",this.trigger.bind(this,"partialdone")),t.on("done",this.trigger.bind(this,"done"))}),this),this.parse708captions_&&(this.cc708Stream_.on("data",this.trigger.bind(this,"data")),this.cc708Stream_.on("partialdone",this.trigger.bind(this,"partialdone")),this.cc708Stream_.on("done",this.trigger.bind(this,"done")))};(ce.prototype=new Bt).push=function(t){var e,i,n;if("sei_rbsp"===t.nalUnitType&&(e=de(t.escapedRBSP)).payload&&e.payloadType===le&&(i=he(e)))if(t.dts<this.latestDts_)this.ignoreNextEqualDts_=!0;else{if(t.dts===this.latestDts_&&this.ignoreNextEqualDts_)return this.numSameDts_--,void(this.numSameDts_||(this.ignoreNextEqualDts_=!1));n=pe(t.pts,i),this.captionPackets_=this.captionPackets_.concat(n),this.latestDts_!==t.dts&&(this.numSameDts_=0),this.numSameDts_++,this.latestDts_=t.dts}},ce.prototype.flushCCStreams=function(t){this.ccStreams_.forEach((function(e){return"flush"===t?e.flush():e.partialFlush()}),this)},ce.prototype.flushStream=function(t){this.captionPackets_.length?(this.captionPackets_.forEach((function(t,e){t.presortIndex=e})),this.captionPackets_.sort((function(t,e){return t.pts===e.pts?t.presortIndex-e.presortIndex:t.pts-e.pts})),this.captionPackets_.forEach((function(t){t.type<2?this.dispatchCea608Packet(t):this.dispatchCea708Packet(t)}),this),this.captionPackets_.length=0,this.flushCCStreams(t)):this.flushCCStreams(t)},ce.prototype.flush=function(){return this.flushStream("flush")},ce.prototype.partialFlush=function(){return this.flushStream("partialFlush")},ce.prototype.reset=function(){this.latestDts_=null,this.ignoreNextEqualDts_=!1,this.numSameDts_=0,this.activeCea608Channel_=[null,null],this.ccStreams_.forEach((function(t){t.reset()}))},ce.prototype.dispatchCea608Packet=function(t){this.setsTextOrXDSActive(t)?this.activeCea608Channel_[t.type]=null:this.setsChannel1Active(t)?this.activeCea608Channel_[t.type]=0:this.setsChannel2Active(t)&&(this.activeCea608Channel_[t.type]=1),null!==this.activeCea608Channel_[t.type]&&this.ccStreams_[(t.type<<1)+this.activeCea608Channel_[t.type]].push(t)},ce.prototype.setsChannel1Active=function(t){return 4096==(30720&t.ccData)},ce.prototype.setsChannel2Active=function(t){return 6144==(30720&t.ccData)},ce.prototype.setsTextOrXDSActive=function(t){return 256==(28928&t.ccData)||4138==(30974&t.ccData)||6186==(30974&t.ccData)},ce.prototype.dispatchCea708Packet=function(t){this.parse708captions_&&this.cc708Stream_.push(t)};var fe={127:9834,4128:32,4129:160,4133:8230,4138:352,4140:338,4144:9608,4145:8216,4146:8217,4147:8220,4148:8221,4149:8226,4153:8482,4154:353,4156:339,4157:8480,4159:376,4214:8539,4215:8540,4216:8541,4217:8542,4218:9168,4219:9124,4220:9123,4221:9135,4222:9126,4223:9121,4256:12600},ge=function(t){return 32<=t&&t<=127||160<=t&&t<=255},me=function(t){this.windowNum=t,this.reset()};me.prototype.reset=function(){this.clearText(),this.pendingNewLine=!1,this.winAttr={},this.penAttr={},this.penLoc={},this.penColor={},this.visible=0,this.rowLock=0,this.columnLock=0,this.priority=0,this.relativePositioning=0,this.anchorVertical=0,this.anchorHorizontal=0,this.anchorPoint=0,this.rowCount=1,this.virtualRowCount=this.rowCount+1,this.columnCount=41,this.windowStyle=0,this.penStyle=0},me.prototype.getText=function(){return this.rows.join("\n")},me.prototype.clearText=function(){this.rows=[""],this.rowIdx=0},me.prototype.newLine=function(t){for(this.rows.length>=this.virtualRowCount&&"function"==typeof this.beforeRowOverflow&&this.beforeRowOverflow(t),this.rows.length>0&&(this.rows.push(""),this.rowIdx++);this.rows.length>this.virtualRowCount;)this.rows.shift(),this.rowIdx--},me.prototype.isEmpty=function(){return 0===this.rows.length||1===this.rows.length&&""===this.rows[0]},me.prototype.addText=function(t){this.rows[this.rowIdx]+=t},me.prototype.backspace=function(){if(!this.isEmpty()){var t=this.rows[this.rowIdx];this.rows[this.rowIdx]=t.substr(0,t.length-1)}};var ye=function(t,e,i){this.serviceNum=t,this.text="",this.currentWindow=new me(-1),this.windows=[],this.stream=i,"string"==typeof e&&this.createTextDecoder(e)};ye.prototype.init=function(t,e){this.startPts=t;for(var i=0;i<8;i++)this.windows[i]=new me(i),"function"==typeof e&&(this.windows[i].beforeRowOverflow=e)},ye.prototype.setCurrentWindow=function(t){this.currentWindow=this.windows[t]},ye.prototype.createTextDecoder=function(t){if("undefined"==typeof TextDecoder)this.stream.trigger("log",{level:"warn",message:"The `encoding` option is unsupported without TextDecoder support"});else try{this.textDecoder_=new TextDecoder(t)}catch(e){this.stream.trigger("log",{level:"warn",message:"TextDecoder could not be created with "+t+" encoding. "+e})}};var Se=function t(e){e=e||{},t.prototype.init.call(this);var i,n=this,a=e.captionServices||{},r={};Object.keys(a).forEach((function(t){i=a[t],/^SERVICE/.test(t)&&(r[t]=i.encoding)})),this.serviceEncodings=r,this.current708Packet=null,this.services={},this.push=function(t){3===t.type?(n.new708Packet(),n.add708Bytes(t)):(null===n.current708Packet&&n.new708Packet(),n.add708Bytes(t))}};Se.prototype=new Bt,Se.prototype.new708Packet=function(){null!==this.current708Packet&&this.push708Packet(),this.current708Packet={data:[],ptsVals:[]}},Se.prototype.add708Bytes=function(t){var e=t.ccData,i=e>>>8,n=255&e;this.current708Packet.ptsVals.push(t.pts),this.current708Packet.data.push(i),this.current708Packet.data.push(n)},Se.prototype.push708Packet=function(){var t=this.current708Packet,e=t.data,i=null,n=null,a=0,r=e[a++];for(t.seq=r>>6,t.sizeCode=63&r;a<e.length;a++)n=31&(r=e[a++]),7===(i=r>>5)&&n>0&&(i=r=e[a++]),this.pushServiceBlock(i,a,n),n>0&&(a+=n-1)},Se.prototype.pushServiceBlock=function(t,e,i){var n,a=e,r=this.current708Packet.data,s=this.services[t];for(s||(s=this.initService(t,a));a<e+i&&a<r.length;a++)n=r[a],ge(n)?a=this.handleText(a,s):24===n?a=this.multiByteCharacter(a,s):16===n?a=this.extendedCommands(a,s):128<=n&&n<=135?a=this.setCurrentWindow(a,s):152<=n&&n<=159?a=this.defineWindow(a,s):136===n?a=this.clearWindows(a,s):140===n?a=this.deleteWindows(a,s):137===n?a=this.displayWindows(a,s):138===n?a=this.hideWindows(a,s):139===n?a=this.toggleWindows(a,s):151===n?a=this.setWindowAttributes(a,s):144===n?a=this.setPenAttributes(a,s):145===n?a=this.setPenColor(a,s):146===n?a=this.setPenLocation(a,s):143===n?s=this.reset(a,s):8===n?s.currentWindow.backspace():12===n?s.currentWindow.clearText():13===n?s.currentWindow.pendingNewLine=!0:14===n?s.currentWindow.clearText():141===n&&a++},Se.prototype.extendedCommands=function(t,e){var i=this.current708Packet.data[++t];return ge(i)&&(t=this.handleText(t,e,{isExtended:!0})),t},Se.prototype.getPts=function(t){return this.current708Packet.ptsVals[Math.floor(t/2)]},Se.prototype.initService=function(t,e){var i,n,a=this;return(i="SERVICE"+t)in this.serviceEncodings&&(n=this.serviceEncodings[i]),this.services[t]=new ye(t,n,a),this.services[t].init(this.getPts(e),(function(e){a.flushDisplayed(e,a.services[t])})),this.services[t]},Se.prototype.handleText=function(t,e,i){var n,a,r,s,o=i&&i.isExtended,d=i&&i.isMultiByte,h=this.current708Packet.data,p=o?4096:0,u=h[t],l=h[t+1],c=e.currentWindow;return e.textDecoder_&&!o?(d?(a=[u,l],t++):a=[u],n=e.textDecoder_.decode(new Uint8Array(a))):(s=fe[r=p|u]||r,n=4096&r&&r===s?"":String.fromCharCode(s)),c.pendingNewLine&&!c.isEmpty()&&c.newLine(this.getPts(t)),c.pendingNewLine=!1,c.addText(n),t},Se.prototype.multiByteCharacter=function(t,e){var i=this.current708Packet.data,n=i[t+1],a=i[t+2];return ge(n)&&ge(a)&&(t=this.handleText(++t,e,{isMultiByte:!0})),t},Se.prototype.setCurrentWindow=function(t,e){var i=7&this.current708Packet.data[t];return e.setCurrentWindow(i),t},Se.prototype.defineWindow=function(t,e){var i=this.current708Packet.data,n=i[t],a=7&n;e.setCurrentWindow(a);var r=e.currentWindow;return n=i[++t],r.visible=(32&n)>>5,r.rowLock=(16&n)>>4,r.columnLock=(8&n)>>3,r.priority=7&n,n=i[++t],r.relativePositioning=(128&n)>>7,r.anchorVertical=127&n,n=i[++t],r.anchorHorizontal=n,n=i[++t],r.anchorPoint=(240&n)>>4,r.rowCount=15&n,n=i[++t],r.columnCount=63&n,n=i[++t],r.windowStyle=(56&n)>>3,r.penStyle=7&n,r.virtualRowCount=r.rowCount+1,t},Se.prototype.setWindowAttributes=function(t,e){var i=this.current708Packet.data,n=i[t],a=e.currentWindow.winAttr;return n=i[++t],a.fillOpacity=(192&n)>>6,a.fillRed=(48&n)>>4,a.fillGreen=(12&n)>>2,a.fillBlue=3&n,n=i[++t],a.borderType=(192&n)>>6,a.borderRed=(48&n)>>4,a.borderGreen=(12&n)>>2,a.borderBlue=3&n,n=i[++t],a.borderType+=(128&n)>>5,a.wordWrap=(64&n)>>6,a.printDirection=(48&n)>>4,a.scrollDirection=(12&n)>>2,a.justify=3&n,n=i[++t],a.effectSpeed=(240&n)>>4,a.effectDirection=(12&n)>>2,a.displayEffect=3&n,t},Se.prototype.flushDisplayed=function(t,e){for(var i=[],n=0;n<8;n++)e.windows[n].visible&&!e.windows[n].isEmpty()&&i.push(e.windows[n].getText());e.endPts=t,e.text=i.join("\n\n"),this.pushCaption(e),e.startPts=t},Se.prototype.pushCaption=function(t){""!==t.text&&(this.trigger("data",{startPts:t.startPts,endPts:t.endPts,text:t.text,stream:"cc708_"+t.serviceNum}),t.text="",t.startPts=t.endPts)},Se.prototype.displayWindows=function(t,e){var i=this.current708Packet.data[++t],n=this.getPts(t);this.flushDisplayed(n,e);for(var a=0;a<8;a++)i&1<<a&&(e.windows[a].visible=1);return t},Se.prototype.hideWindows=function(t,e){var i=this.current708Packet.data[++t],n=this.getPts(t);this.flushDisplayed(n,e);for(var a=0;a<8;a++)i&1<<a&&(e.windows[a].visible=0);return t},Se.prototype.toggleWindows=function(t,e){var i=this.current708Packet.data[++t],n=this.getPts(t);this.flushDisplayed(n,e);for(var a=0;a<8;a++)i&1<<a&&(e.windows[a].visible^=1);return t},Se.prototype.clearWindows=function(t,e){var i=this.current708Packet.data[++t],n=this.getPts(t);this.flushDisplayed(n,e);for(var a=0;a<8;a++)i&1<<a&&e.windows[a].clearText();return t},Se.prototype.deleteWindows=function(t,e){var i=this.current708Packet.data[++t],n=this.getPts(t);this.flushDisplayed(n,e);for(var a=0;a<8;a++)i&1<<a&&e.windows[a].reset();return t},Se.prototype.setPenAttributes=function(t,e){var i=this.current708Packet.data,n=i[t],a=e.currentWindow.penAttr;return n=i[++t],a.textTag=(240&n)>>4,a.offset=(12&n)>>2,a.penSize=3&n,n=i[++t],a.italics=(128&n)>>7,a.underline=(64&n)>>6,a.edgeType=(56&n)>>3,a.fontStyle=7&n,t},Se.prototype.setPenColor=function(t,e){var i=this.current708Packet.data,n=i[t],a=e.currentWindow.penColor;return n=i[++t],a.fgOpacity=(192&n)>>6,a.fgRed=(48&n)>>4,a.fgGreen=(12&n)>>2,a.fgBlue=3&n,n=i[++t],a.bgOpacity=(192&n)>>6,a.bgRed=(48&n)>>4,a.bgGreen=(12&n)>>2,a.bgBlue=3&n,n=i[++t],a.edgeRed=(48&n)>>4,a.edgeGreen=(12&n)>>2,a.edgeBlue=3&n,t},Se.prototype.setPenLocation=function(t,e){var i=this.current708Packet.data,n=i[t],a=e.currentWindow.penLoc;return e.currentWindow.pendingNewLine=!0,n=i[++t],a.row=15&n,n=i[++t],a.column=63&n,t},Se.prototype.reset=function(t,e){var i=this.getPts(t);return this.flushDisplayed(i,e),this.initService(e.serviceNum,t)};var ve={42:225,92:233,94:237,95:243,96:250,123:231,124:247,125:209,126:241,127:9608,304:174,305:176,306:189,307:191,308:8482,309:162,310:163,311:9834,312:224,313:160,314:232,315:226,316:234,317:238,318:244,319:251,544:193,545:201,546:211,547:218,548:220,549:252,550:8216,551:161,552:42,553:39,554:8212,555:169,556:8480,557:8226,558:8220,559:8221,560:192,561:194,562:199,563:200,564:202,565:203,566:235,567:206,568:207,569:239,570:212,571:217,572:249,573:219,574:171,575:187,800:195,801:227,802:205,803:204,804:236,805:210,806:242,807:213,808:245,809:123,810:125,811:92,812:94,813:95,814:124,815:126,816:196,817:228,818:214,819:246,820:223,821:165,822:164,823:9474,824:197,825:229,826:216,827:248,828:9484,829:9488,830:9492,831:9496},be=function(t){return null===t?"":(t=ve[t]||t,String.fromCharCode(t))},_e=[4352,4384,4608,4640,5376,5408,5632,5664,5888,5920,4096,4864,4896,5120,5152],we=function(){for(var t=[],e=15;e--;)t.push("");return t},Te=function t(e,i){t.prototype.init.call(this),this.field_=e||0,this.dataChannel_=i||0,this.name_="CC"+(1+(this.field_<<1|this.dataChannel_)),this.setConstants(),this.reset(),this.push=function(t){var e,i,n,a,r;if((e=32639&t.ccData)!==this.lastControlCode_){if(4096==(61440&e)?this.lastControlCode_=e:e!==this.PADDING_&&(this.lastControlCode_=null),n=e>>>8,a=255&e,e!==this.PADDING_)if(e===this.RESUME_CAPTION_LOADING_)this.mode_="popOn";else if(e===this.END_OF_CAPTION_)this.mode_="popOn",this.clearFormatting(t.pts),this.flushDisplayed(t.pts),i=this.displayed_,this.displayed_=this.nonDisplayed_,this.nonDisplayed_=i,this.startPts_=t.pts;else if(e===this.ROLL_UP_2_ROWS_)this.rollUpRows_=2,this.setRollUp(t.pts);else if(e===this.ROLL_UP_3_ROWS_)this.rollUpRows_=3,this.setRollUp(t.pts);else if(e===this.ROLL_UP_4_ROWS_)this.rollUpRows_=4,this.setRollUp(t.pts);else if(e===this.CARRIAGE_RETURN_)this.clearFormatting(t.pts),this.flushDisplayed(t.pts),this.shiftRowsUp_(),this.startPts_=t.pts;else if(e===this.BACKSPACE_)"popOn"===this.mode_?this.nonDisplayed_[this.row_]=this.nonDisplayed_[this.row_].slice(0,-1):this.displayed_[this.row_]=this.displayed_[this.row_].slice(0,-1);else if(e===this.ERASE_DISPLAYED_MEMORY_)this.flushDisplayed(t.pts),this.displayed_=we();else if(e===this.ERASE_NON_DISPLAYED_MEMORY_)this.nonDisplayed_=we();else if(e===this.RESUME_DIRECT_CAPTIONING_)"paintOn"!==this.mode_&&(this.flushDisplayed(t.pts),this.displayed_=we()),this.mode_="paintOn",this.startPts_=t.pts;else if(this.isSpecialCharacter(n,a))r=be((n=(3&n)<<8)|a),this[this.mode_](t.pts,r),this.column_++;else if(this.isExtCharacter(n,a))"popOn"===this.mode_?this.nonDisplayed_[this.row_]=this.nonDisplayed_[this.row_].slice(0,-1):this.displayed_[this.row_]=this.displayed_[this.row_].slice(0,-1),r=be((n=(3&n)<<8)|a),this[this.mode_](t.pts,r),this.column_++;else if(this.isMidRowCode(n,a))this.clearFormatting(t.pts),this[this.mode_](t.pts," "),this.column_++,14==(14&a)&&this.addFormatting(t.pts,["i"]),1==(1&a)&&this.addFormatting(t.pts,["u"]);else if(this.isOffsetControlCode(n,a))this.column_+=3&a;else if(this.isPAC(n,a)){var s=_e.indexOf(7968&e);"rollUp"===this.mode_&&(s-this.rollUpRows_+1<0&&(s=this.rollUpRows_-1),this.setRollUp(t.pts,s)),s!==this.row_&&(this.clearFormatting(t.pts),this.row_=s),1&a&&-1===this.formatting_.indexOf("u")&&this.addFormatting(t.pts,["u"]),16==(16&e)&&(this.column_=4*((14&e)>>1)),this.isColorPAC(a)&&14==(14&a)&&this.addFormatting(t.pts,["i"])}else this.isNormalChar(n)&&(0===a&&(a=null),r=be(n),r+=be(a),this[this.mode_](t.pts,r),this.column_+=r.length)}else this.lastControlCode_=null}};Te.prototype=new Bt,Te.prototype.flushDisplayed=function(t){var e=this.displayed_.map((function(t,e){try{return t.trim()}catch(t){return this.trigger("log",{level:"warn",message:"Skipping a malformed 608 caption at index "+e+"."}),""}}),this).join("\n").replace(/^\n+|\n+$/g,"");e.length&&this.trigger("data",{startPts:this.startPts_,endPts:t,text:e,stream:this.name_})},Te.prototype.reset=function(){this.mode_="popOn",this.topRow_=0,this.startPts_=0,this.displayed_=we(),this.nonDisplayed_=we(),this.lastControlCode_=null,this.column_=0,this.row_=14,this.rollUpRows_=2,this.formatting_=[]},Te.prototype.setConstants=function(){0===this.dataChannel_?(this.BASE_=16,this.EXT_=17,this.CONTROL_=(20|this.field_)<<8,this.OFFSET_=23):1===this.dataChannel_&&(this.BASE_=24,this.EXT_=25,this.CONTROL_=(28|this.field_)<<8,this.OFFSET_=31),this.PADDING_=0,this.RESUME_CAPTION_LOADING_=32|this.CONTROL_,this.END_OF_CAPTION_=47|this.CONTROL_,this.ROLL_UP_2_ROWS_=37|this.CONTROL_,this.ROLL_UP_3_ROWS_=38|this.CONTROL_,this.ROLL_UP_4_ROWS_=39|this.CONTROL_,this.CARRIAGE_RETURN_=45|this.CONTROL_,this.RESUME_DIRECT_CAPTIONING_=41|this.CONTROL_,this.BACKSPACE_=33|this.CONTROL_,this.ERASE_DISPLAYED_MEMORY_=44|this.CONTROL_,this.ERASE_NON_DISPLAYED_MEMORY_=46|this.CONTROL_},Te.prototype.isSpecialCharacter=function(t,e){return t===this.EXT_&&e>=48&&e<=63},Te.prototype.isExtCharacter=function(t,e){return(t===this.EXT_+1||t===this.EXT_+2)&&e>=32&&e<=63},Te.prototype.isMidRowCode=function(t,e){return t===this.EXT_&&e>=32&&e<=47},Te.prototype.isOffsetControlCode=function(t,e){return t===this.OFFSET_&&e>=33&&e<=35},Te.prototype.isPAC=function(t,e){return t>=this.BASE_&&t<this.BASE_+8&&e>=64&&e<=127},Te.prototype.isColorPAC=function(t){return t>=64&&t<=79||t>=96&&t<=127},Te.prototype.isNormalChar=function(t){return t>=32&&t<=127},Te.prototype.setRollUp=function(t,e){if("rollUp"!==this.mode_&&(this.row_=14,this.mode_="rollUp",this.flushDisplayed(t),this.nonDisplayed_=we(),this.displayed_=we()),void 0!==e&&e!==this.row_)for(var i=0;i<this.rollUpRows_;i++)this.displayed_[e-i]=this.displayed_[this.row_-i],this.displayed_[this.row_-i]="";void 0===e&&(e=this.row_),this.topRow_=e-this.rollUpRows_+1},Te.prototype.addFormatting=function(t,e){this.formatting_=this.formatting_.concat(e);var i=e.reduce((function(t,e){return t+"<"+e+">"}),"");this[this.mode_](t,i)},Te.prototype.clearFormatting=function(t){if(this.formatting_.length){var e=this.formatting_.reverse().reduce((function(t,e){return t+"</"+e+">"}),"");this.formatting_=[],this[this.mode_](t,e)}},Te.prototype.popOn=function(t,e){var i=this.nonDisplayed_[this.row_];i+=e,this.nonDisplayed_[this.row_]=i},Te.prototype.rollUp=function(t,e){var i=this.displayed_[this.row_];i+=e,this.displayed_[this.row_]=i},Te.prototype.shiftRowsUp_=function(){var t;for(t=0;t<this.topRow_;t++)this.displayed_[t]="";for(t=this.row_+1;t<15;t++)this.displayed_[t]="";for(t=this.topRow_;t<this.row_;t++)this.displayed_[t]=this.displayed_[t+1];this.displayed_[this.row_]=""},Te.prototype.paintOn=function(t,e){var i=this.displayed_[this.row_];i+=e,this.displayed_[this.row_]=i};var Ce={CaptionStream:ce,Cea608Stream:Te,Cea708Stream:Se},ke={H264_STREAM_TYPE:27,ADTS_STREAM_TYPE:15,METADATA_STREAM_TYPE:21},Pe="shared",Ae=function(t,e){var i=1;for(t>e&&(i=-1);Math.abs(e-t)>4294967296;)t+=8589934592*i;return t},Ue=function t(e){var i,n;t.prototype.init.call(this),this.type_=e||Pe,this.push=function(t){this.type_!==Pe&&t.type!==this.type_||(void 0===n&&(n=t.dts),t.dts=Ae(t.dts,n),t.pts=Ae(t.pts,n),i=t.dts,this.trigger("data",t))},this.flush=function(){n=i,this.trigger("done")},this.endTimeline=function(){this.flush(),this.trigger("endedtimeline")},this.discontinuity=function(){n=void 0,i=void 0},this.reset=function(){this.discontinuity(),this.trigger("reset")}};Ue.prototype=new Bt;var De,Ee=Ue;(De=function(t){var e,i={descriptor:t&&t.descriptor},n=0,a=[],r=0;if(De.prototype.init.call(this),this.dispatchType=ke.METADATA_STREAM_TYPE.toString(16),i.descriptor)for(e=0;e<i.descriptor.length;e++)this.dispatchType+=("00"+i.descriptor[e].toString(16)).slice(-2);this.push=function(t){var e,i,s,o,d;if("timed-metadata"===t.type)if(t.dataAlignmentIndicator&&(r=0,a.length=0),0===a.length&&(t.data.length<10||t.data[0]!=="I".charCodeAt(0)||t.data[1]!=="D".charCodeAt(0)||t.data[2]!=="3".charCodeAt(0)))this.trigger("log",{level:"warn",message:"Skipping unrecognized metadata packet"});else if(a.push(t),r+=t.data.byteLength,1===a.length&&(n=Tt.parseSyncSafeInteger(t.data.subarray(6,10)),n+=10),!(r<n)){for(e={data:new Uint8Array(n),frames:[],pts:a[0].pts,dts:a[0].dts},d=0;d<n;)e.data.set(a[0].data.subarray(0,n-d),d),d+=a[0].data.byteLength,r-=a[0].data.byteLength,a.shift();i=10,64&e.data[5]&&(i+=4,i+=Tt.parseSyncSafeInteger(e.data.subarray(10,14)),n-=Tt.parseSyncSafeInteger(e.data.subarray(16,20)));do{if((s=Tt.parseSyncSafeInteger(e.data.subarray(i+4,i+8)))<1){this.trigger("log",{level:"warn",message:"Malformed ID3 frame encountered. Skipping remaining metadata parsing."});break}if((o={id:String.fromCharCode(e.data[i],e.data[i+1],e.data[i+2],e.data[i+3]),data:e.data.subarray(i+10,i+s+10)}).key=o.id,Tt.frameParsers[o.id]?Tt.frameParsers[o.id](o):"T"===o.id[0]?Tt.frameParsers["T*"](o):"W"===o.id[0]&&Tt.frameParsers["W*"](o),"com.apple.streaming.transportStreamTimestamp"===o.owner){var h=o.data,p=(1&h[3])<<30|h[4]<<22|h[5]<<14|h[6]<<6|h[7]>>>2;p*=4,p+=3&h[7],o.timeStamp=p,void 0===e.pts&&void 0===e.dts&&(e.pts=o.timeStamp,e.dts=o.timeStamp),this.trigger("timestamp",o)}e.frames.push(o),i+=10,i+=s}while(i<n);this.trigger("data",e)}}}).prototype=new Bt;var Le,xe,Oe,Ie=De,Re=Ee,Me=188;(Le=function(){var t=new Uint8Array(Me),e=0;Le.prototype.init.call(this),this.push=function(i){var n,a=0,r=Me;for(e?((n=new Uint8Array(i.byteLength+e)).set(t.subarray(0,e)),n.set(i,e),e=0):n=i;r<n.byteLength;)71!==n[a]||71!==n[r]?(a++,r++):(this.trigger("data",n.subarray(a,r)),a+=Me,r+=Me);a<n.byteLength&&(t.set(n.subarray(a),0),e=n.byteLength-a)},this.flush=function(){e===Me&&71===t[0]&&(this.trigger("data",t),e=0),this.trigger("done")},this.endTimeline=function(){this.flush(),this.trigger("endedtimeline")},this.reset=function(){e=0,this.trigger("reset")}}).prototype=new Bt,(xe=function(){var t,e,i,n;xe.prototype.init.call(this),n=this,this.packetsWaitingForPmt=[],this.programMapTable=void 0,t=function(t,n){var a=0;n.payloadUnitStartIndicator&&(a+=t[a]+1),"pat"===n.type?e(t.subarray(a),n):i(t.subarray(a),n)},e=function(t,e){e.section_number=t[7],e.last_section_number=t[8],n.pmtPid=(31&t[10])<<8|t[11],e.pmtPid=n.pmtPid},i=function(t,e){var i,a;if(1&t[5]){for(n.programMapTable={video:null,audio:null,"timed-metadata":{}},i=3+((15&t[1])<<8|t[2])-4,a=12+((15&t[10])<<8|t[11]);a<i;){var r=t[a],s=(31&t[a+1])<<8|t[a+2];r===ke.H264_STREAM_TYPE&&null===n.programMapTable.video?n.programMapTable.video=s:r===ke.ADTS_STREAM_TYPE&&null===n.programMapTable.audio?n.programMapTable.audio=s:r===ke.METADATA_STREAM_TYPE&&(n.programMapTable["timed-metadata"][s]=r),a+=5+((15&t[a+3])<<8|t[a+4])}e.programMapTable=n.programMapTable}},this.push=function(e){var i={},n=4;if(i.payloadUnitStartIndicator=!!(64&e[1]),i.pid=31&e[1],i.pid<<=8,i.pid|=e[2],(48&e[3])>>>4>1&&(n+=e[n]+1),0===i.pid)i.type="pat",t(e.subarray(n),i),this.trigger("data",i);else if(i.pid===this.pmtPid)for(i.type="pmt",t(e.subarray(n),i),this.trigger("data",i);this.packetsWaitingForPmt.length;)this.processPes_.apply(this,this.packetsWaitingForPmt.shift());else void 0===this.programMapTable?this.packetsWaitingForPmt.push([e,n,i]):this.processPes_(e,n,i)},this.processPes_=function(t,e,i){i.pid===this.programMapTable.video?i.streamType=ke.H264_STREAM_TYPE:i.pid===this.programMapTable.audio?i.streamType=ke.ADTS_STREAM_TYPE:i.streamType=this.programMapTable["timed-metadata"][i.pid],i.type="pes",i.data=t.subarray(e),this.trigger("data",i)}}).prototype=new Bt,xe.STREAM_TYPES={h264:27,adts:15},(Oe=function(){var t,e=this,i=!1,n={data:[],size:0},a={data:[],size:0},r={data:[],size:0},s=function(t,i,n){var a,r,s=new Uint8Array(t.size),o={type:i},d=0,h=0;if(t.data.length&&!(t.size<9)){for(o.trackId=t.data[0].pid,d=0;d<t.data.length;d++)r=t.data[d],s.set(r.data,h),h+=r.data.byteLength;var p,u,l,c;u=o,c=(p=s)[0]<<16|p[1]<<8|p[2],u.data=new Uint8Array,1===c&&(u.packetLength=6+(p[4]<<8|p[5]),u.dataAlignmentIndicator=0!=(4&p[6]),192&(l=p[7])&&(u.pts=(14&p[9])<<27|(255&p[10])<<20|(254&p[11])<<12|(255&p[12])<<5|(254&p[13])>>>3,u.pts*=4,u.pts+=(6&p[13])>>>1,u.dts=u.pts,64&l&&(u.dts=(14&p[14])<<27|(255&p[15])<<20|(254&p[16])<<12|(255&p[17])<<5|(254&p[18])>>>3,u.dts*=4,u.dts+=(6&p[18])>>>1)),u.data=p.subarray(9+p[8])),a="video"===i||o.packetLength<=t.size,(n||a)&&(t.size=0,t.data.length=0),a&&e.trigger("data",o)}};Oe.prototype.init.call(this),this.push=function(o){({pat:function(){},pes:function(){var t,e;switch(o.streamType){case ke.H264_STREAM_TYPE:t=n,e="video";break;case ke.ADTS_STREAM_TYPE:t=a,e="audio";break;case ke.METADATA_STREAM_TYPE:t=r,e="timed-metadata";break;default:return}o.payloadUnitStartIndicator&&s(t,e,!0),t.data.push(o),t.size+=o.data.byteLength},pmt:function(){var n={type:"metadata",tracks:[]};null!==(t=o.programMapTable).video&&n.tracks.push({timelineStartInfo:{baseMediaDecodeTime:0},id:+t.video,codec:"avc",type:"video"}),null!==t.audio&&n.tracks.push({timelineStartInfo:{baseMediaDecodeTime:0},id:+t.audio,codec:"adts",type:"audio"}),i=!0,e.trigger("data",n)}})[o.type]()},this.reset=function(){n.size=0,n.data.length=0,a.size=0,a.data.length=0,this.trigger("reset")},this.flushStreams_=function(){s(n,"video"),s(a,"audio"),s(r,"timed-metadata")},this.flush=function(){if(!i&&t){var n={type:"metadata",tracks:[]};null!==t.video&&n.tracks.push({timelineStartInfo:{baseMediaDecodeTime:0},id:+t.video,codec:"avc",type:"video"}),null!==t.audio&&n.tracks.push({timelineStartInfo:{baseMediaDecodeTime:0},id:+t.audio,codec:"adts",type:"audio"}),e.trigger("data",n)}i=!1,this.flushStreams_(),this.trigger("done")}}).prototype=new Bt;var Ne={PAT_PID:0,MP2T_PACKET_LENGTH:Me,TransportPacketStream:Le,TransportParseStream:xe,ElementaryStream:Oe,TimestampRolloverStream:Re,CaptionStream:Ce.CaptionStream,Cea608Stream:Ce.Cea608Stream,Cea708Stream:Ce.Cea708Stream,MetadataStream:Ie};for(var Be in ke)ke.hasOwnProperty(Be)&&(Ne[Be]=ke[Be]);var We,Ge=Ne,ze=Zt,Fe=[96e3,88200,64e3,48e3,44100,32e3,24e3,22050,16e3,12e3,11025,8e3,7350];(We=function(t){var e,i=0;We.prototype.init.call(this),this.skipWarn_=function(t,e){this.trigger("log",{level:"warn",message:"adts skiping bytes "+t+" to "+e+" in frame "+i+" outside syncword"})},this.push=function(n){var a,r,s,o,d,h=0;if(t||(i=0),"audio"===n.type){var p;for(e&&e.length?(s=e,(e=new Uint8Array(s.byteLength+n.data.byteLength)).set(s),e.set(n.data,s.byteLength)):e=n.data;h+7<e.length;)if(255===e[h]&&240==(246&e[h+1])){if("number"==typeof p&&(this.skipWarn_(p,h),p=null),r=2*(1&~e[h+1]),a=(3&e[h+3])<<11|e[h+4]<<3|(224&e[h+5])>>5,d=(o=1024*(1+(3&e[h+6])))*ze/Fe[(60&e[h+2])>>>2],e.byteLength-h<a)break;this.trigger("data",{pts:n.pts+i*d,dts:n.dts+i*d,sampleCount:o,audioobjecttype:1+(e[h+2]>>>6&3),channelcount:(1&e[h+2])<<2|(192&e[h+3])>>>6,samplerate:Fe[(60&e[h+2])>>>2],samplingfrequencyindex:(60&e[h+2])>>>2,samplesize:16,data:e.subarray(h+7+r,h+a)}),i++,h+=a}else"number"!=typeof p&&(p=h),h++;"number"==typeof p&&(this.skipWarn_(p,h),p=null),e=e.subarray(h)}},this.flush=function(){i=0,this.trigger("done")},this.reset=function(){e=void 0,this.trigger("reset")},this.endTimeline=function(){e=void 0,this.trigger("endedtimeline")}}).prototype=new Bt;var Ve,Ye,Xe,je=We,qe=function(t){var e=t.byteLength,i=0,n=0;this.length=function(){return 8*e},this.bitsAvailable=function(){return 8*e+n},this.loadWord=function(){var a=t.byteLength-e,r=new Uint8Array(4),s=Math.min(4,e);if(0===s)throw new Error("no bytes available");r.set(t.subarray(a,a+s)),i=new DataView(r.buffer).getUint32(0),n=8*s,e-=s},this.skipBits=function(t){var a;n>t?(i<<=t,n-=t):(t-=n,t-=8*(a=Math.floor(t/8)),e-=a,this.loadWord(),i<<=t,n-=t)},this.readBits=function(t){var a=Math.min(n,t),r=i>>>32-a;return(n-=a)>0?i<<=a:e>0&&this.loadWord(),(a=t-a)>0?r<<a|this.readBits(a):r},this.skipLeadingZeros=function(){var t;for(t=0;t<n;++t)if(0!=(i&2147483648>>>t))return i<<=t,n-=t,t;return this.loadWord(),t+this.skipLeadingZeros()},this.skipUnsignedExpGolomb=function(){this.skipBits(1+this.skipLeadingZeros())},this.skipExpGolomb=function(){this.skipBits(1+this.skipLeadingZeros())},this.readUnsignedExpGolomb=function(){var t=this.skipLeadingZeros();return this.readBits(t+1)-1},this.readExpGolomb=function(){var t=this.readUnsignedExpGolomb();return 1&t?1+t>>>1:-1*(t>>>1)},this.readBoolean=function(){return 1===this.readBits(1)},this.readUnsignedByte=function(){return this.readBits(8)},this.loadWord()};(Ye=function(){var t,e,i=0;Ye.prototype.init.call(this),this.push=function(n){var a;e?((a=new Uint8Array(e.byteLength+n.data.byteLength)).set(e),a.set(n.data,e.byteLength),e=a):e=n.data;for(var r=e.byteLength;i<r-3;i++)if(1===e[i+2]){t=i+5;break}for(;t<r;)switch(e[t]){case 0:if(0!==e[t-1]){t+=2;break}if(0!==e[t-2]){t++;break}i+3!==t-2&&this.trigger("data",e.subarray(i+3,t-2));do{t++}while(1!==e[t]&&t<r);i=t-2,t+=3;break;case 1:if(0!==e[t-1]||0!==e[t-2]){t+=3;break}this.trigger("data",e.subarray(i+3,t-2)),i=t-2,t+=3;break;default:t+=3}e=e.subarray(i),t-=i,i=0},this.reset=function(){e=null,i=0,this.trigger("reset")},this.flush=function(){e&&e.byteLength>3&&this.trigger("data",e.subarray(i+3)),e=null,i=0,this.trigger("done")},this.endTimeline=function(){this.flush(),this.trigger("endedtimeline")}}).prototype=new Bt,Xe={100:!0,110:!0,122:!0,244:!0,44:!0,83:!0,86:!0,118:!0,128:!0,138:!0,139:!0,134:!0},(Ve=function(){var t,e,i,n,a,r,s,o=new Ye;Ve.prototype.init.call(this),t=this,this.push=function(t){"video"===t.type&&(e=t.trackId,i=t.pts,n=t.dts,o.push(t))},o.on("data",(function(s){var o={trackId:e,pts:i,dts:n,data:s,nalUnitTypeCode:31&s[0]};switch(o.nalUnitTypeCode){case 5:o.nalUnitType="slice_layer_without_partitioning_rbsp_idr";break;case 6:o.nalUnitType="sei_rbsp",o.escapedRBSP=a(s.subarray(1));break;case 7:o.nalUnitType="seq_parameter_set_rbsp",o.escapedRBSP=a(s.subarray(1)),o.config=r(o.escapedRBSP);break;case 8:o.nalUnitType="pic_parameter_set_rbsp";break;case 9:o.nalUnitType="access_unit_delimiter_rbsp"}t.trigger("data",o)})),o.on("done",(function(){t.trigger("done")})),o.on("partialdone",(function(){t.trigger("partialdone")})),o.on("reset",(function(){t.trigger("reset")})),o.on("endedtimeline",(function(){t.trigger("endedtimeline")})),this.flush=function(){o.flush()},this.partialFlush=function(){o.partialFlush()},this.reset=function(){o.reset()},this.endTimeline=function(){o.endTimeline()},s=function(t,e){var i,n=8,a=8;for(i=0;i<t;i++)0!==a&&(a=(n+e.readExpGolomb()+256)%256),n=0===a?n:a},a=function(t){for(var e,i,n=t.byteLength,a=[],r=1;r<n-2;)0===t[r]&&0===t[r+1]&&3===t[r+2]?(a.push(r+2),r+=2):r++;if(0===a.length)return t;e=n-a.length,i=new Uint8Array(e);var s=0;for(r=0;r<e;s++,r++)s===a[0]&&(s++,a.shift()),i[r]=t[s];return i},r=function(t){var e,i,n,a,r,o,d,h,p,u,l,c,f=0,g=0,m=0,y=0,S=[1,1];if(i=(e=new qe(t)).readUnsignedByte(),a=e.readUnsignedByte(),n=e.readUnsignedByte(),e.skipUnsignedExpGolomb(),Xe[i]&&(3===(r=e.readUnsignedExpGolomb())&&e.skipBits(1),e.skipUnsignedExpGolomb(),e.skipUnsignedExpGolomb(),e.skipBits(1),e.readBoolean()))for(l=3!==r?8:12,c=0;c<l;c++)e.readBoolean()&&s(c<6?16:64,e);if(e.skipUnsignedExpGolomb(),0===(o=e.readUnsignedExpGolomb()))e.readUnsignedExpGolomb();else if(1===o)for(e.skipBits(1),e.skipExpGolomb(),e.skipExpGolomb(),d=e.readUnsignedExpGolomb(),c=0;c<d;c++)e.skipExpGolomb();if(e.skipUnsignedExpGolomb(),e.skipBits(1),h=e.readUnsignedExpGolomb(),p=e.readUnsignedExpGolomb(),0===(u=e.readBits(1))&&e.skipBits(1),e.skipBits(1),e.readBoolean()&&(f=e.readUnsignedExpGolomb(),g=e.readUnsignedExpGolomb(),m=e.readUnsignedExpGolomb(),y=e.readUnsignedExpGolomb()),e.readBoolean()&&e.readBoolean()){switch(e.readUnsignedByte()){case 1:S=[1,1];break;case 2:S=[12,11];break;case 3:S=[10,11];break;case 4:S=[16,11];break;case 5:S=[40,33];break;case 6:S=[24,11];break;case 7:S=[20,11];break;case 8:S=[32,11];break;case 9:S=[80,33];break;case 10:S=[18,11];break;case 11:S=[15,11];break;case 12:S=[64,33];break;case 13:S=[160,99];break;case 14:S=[4,3];break;case 15:S=[3,2];break;case 16:S=[2,1];break;case 255:S=[e.readUnsignedByte()<<8|e.readUnsignedByte(),e.readUnsignedByte()<<8|e.readUnsignedByte()]}S&&(S[0],S[1])}return{profileIdc:i,levelIdc:n,profileCompatibility:a,width:16*(h+1)-2*f-2*g,height:(2-u)*(p+1)*16-2*m-2*y,sarRatio:S}}}).prototype=new Bt;var He,$e={H264Stream:Ve,NalByteStream:Ye},Ze=function(t,e){var i=t[e+6]<<21|t[e+7]<<14|t[e+8]<<7|t[e+9];return i=i>=0?i:0,(16&t[e+5])>>4?i+20:i+10},Ke=function t(e,i){return e.length-i<10||e[i]!=="I".charCodeAt(0)||e[i+1]!=="D".charCodeAt(0)||e[i+2]!=="3".charCodeAt(0)?i:t(e,i+=Ze(e,i))},Je=function(t){var e=Ke(t,0);return t.length>=e+2&&255==(255&t[e])&&240==(240&t[e+1])&&16==(22&t[e+1])},Qe=Ze,ti=function(t,e){var i=(224&t[e+5])>>5,n=t[e+4]<<3;return 6144&t[e+3]|n|i};(He=function(){var t=new Uint8Array,e=0;He.prototype.init.call(this),this.setTimestamp=function(t){e=t},this.push=function(i){var n,a,r,s,o=0,d=0;for(t.length?(s=t.length,(t=new Uint8Array(i.byteLength+s)).set(t.subarray(0,s)),t.set(i,s)):t=i;t.length-d>=3;)if(t[d]!=="I".charCodeAt(0)||t[d+1]!=="D".charCodeAt(0)||t[d+2]!=="3".charCodeAt(0))if(255!=(255&t[d])||240!=(240&t[d+1]))d++;else{if(t.length-d<7)break;if(d+(o=ti(t,d))>t.length)break;r={type:"audio",data:t.subarray(d,d+o),pts:e,dts:e},this.trigger("data",r),d+=o}else{if(t.length-d<10)break;if(d+(o=Qe(t,d))>t.length)break;a={type:"timed-metadata",data:t.subarray(d,d+o)},this.trigger("data",a),d+=o}n=t.length-d,t=n>0?t.subarray(d):new Uint8Array},this.reset=function(){t=new Uint8Array,this.trigger("reset")},this.endTimeline=function(){t=new Uint8Array,this.trigger("endedtimeline")}}).prototype=new Bt;var ei,ii,ni,ai,ri=He,si=["audioobjecttype","channelcount","samplerate","samplingfrequencyindex","samplesize"],oi=["width","height","profileIdc","levelIdc","profileCompatibility","sarRatio"],di=$e.H264Stream,hi=Je,pi=Zt,ui=function(t,e){e.stream=t,this.trigger("log",e)},li=function(t,e){for(var i=Object.keys(e),n=0;n<i.length;n++){var a=i[n];"headOfPipeline"!==a&&e[a].on&&e[a].on("log",ui.bind(t,a))}},ci=function(t,e){var i;if(t.length!==e.length)return!1;for(i=0;i<t.length;i++)if(t[i]!==e[i])return!1;return!0},fi=function(t,e,i,n,a,r){return{start:{dts:t,pts:t+(i-e)},end:{dts:t+(n-e),pts:t+(a-i)},prependedContentDuration:r,baseMediaDecodeTime:t}};(ii=function(t,e){var i,n=[],a=0,r=0,s=1/0;i=(e=e||{}).firstSequenceNumber||0,ii.prototype.init.call(this),this.push=function(e){oe(t,e),t&&si.forEach((function(i){t[i]=e[i]})),n.push(e)},this.setEarliestDts=function(t){a=t},this.setVideoBaseMediaDecodeTime=function(t){s=t},this.setAudioAppendStart=function(t){r=t},this.flush=function(){var o,d,h,p,u,l,c;0!==n.length?(o=ee(n,t,a),t.baseMediaDecodeTime=se(t,e.keepOriginalTimestamps),c=te(t,o,r,s),t.samples=ie(o),h=Q.mdat(ne(o)),n=[],d=Q.moof(i,[t]),p=new Uint8Array(d.byteLength+h.byteLength),i++,p.set(d),p.set(h,d.byteLength),re(t),u=Math.ceil(1024*pi/t.samplerate),o.length&&(l=o.length*u,this.trigger("segmentTimingInfo",fi(Kt(t.baseMediaDecodeTime,t.samplerate),o[0].dts,o[0].pts,o[0].dts+l,o[0].pts+l,c||0)),this.trigger("timingInfo",{start:o[0].pts,end:o[0].pts+l})),this.trigger("data",{track:t,boxes:p}),this.trigger("done","AudioSegmentStream")):this.trigger("done","AudioSegmentStream")},this.reset=function(){re(t),n=[],this.trigger("reset")}}).prototype=new Bt,(ei=function(t,e){var i,n,a,r=[],s=[];i=(e=e||{}).firstSequenceNumber||0,ei.prototype.init.call(this),delete t.minPTS,this.gopCache_=[],this.push=function(e){oe(t,e),"seq_parameter_set_rbsp"!==e.nalUnitType||n||(n=e.config,t.sps=[e.data],oi.forEach((function(e){t[e]=n[e]}),this)),"pic_parameter_set_rbsp"!==e.nalUnitType||a||(a=e.data,t.pps=[e.data]),r.push(e)},this.flush=function(){for(var n,a,o,d,h,p,u,l,c=0;r.length&&"access_unit_delimiter_rbsp"!==r[0].nalUnitType;)r.shift();if(0===r.length)return this.resetStream_(),void this.trigger("done","VideoSegmentStream");if(n=Gt(r),(o=zt(n))[0][0].keyFrame||((a=this.getGopForFusion_(r[0],t))?(c=a.duration,o.unshift(a),o.byteLength+=a.byteLength,o.nalCount+=a.nalCount,o.pts=a.pts,o.dts=a.dts,o.duration+=a.duration):o=Ft(o)),s.length){var f;if(!(f=e.alignGopsAtEnd?this.alignGopsAtEnd_(o):this.alignGopsAtStart_(o)))return this.gopCache_.unshift({gop:o.pop(),pps:t.pps,sps:t.sps}),this.gopCache_.length=Math.min(6,this.gopCache_.length),r=[],this.resetStream_(),void this.trigger("done","VideoSegmentStream");re(t),o=f}oe(t,o),t.samples=Vt(o),h=Q.mdat(Yt(o)),t.baseMediaDecodeTime=se(t,e.keepOriginalTimestamps),this.trigger("processedGopsInfo",o.map((function(t){return{pts:t.pts,dts:t.dts,byteLength:t.byteLength}}))),u=o[0],l=o[o.length-1],this.trigger("segmentTimingInfo",fi(t.baseMediaDecodeTime,u.dts,u.pts,l.dts+l.duration,l.pts+l.duration,c)),this.trigger("timingInfo",{start:o[0].pts,end:o[o.length-1].pts+o[o.length-1].duration}),this.gopCache_.unshift({gop:o.pop(),pps:t.pps,sps:t.sps}),this.gopCache_.length=Math.min(6,this.gopCache_.length),r=[],this.trigger("baseMediaDecodeTime",t.baseMediaDecodeTime),this.trigger("timelineStartInfo",t.timelineStartInfo),d=Q.moof(i,[t]),p=new Uint8Array(d.byteLength+h.byteLength),i++,p.set(d),p.set(h,d.byteLength),this.trigger("data",{track:t,boxes:p}),this.resetStream_(),this.trigger("done","VideoSegmentStream")},this.reset=function(){this.resetStream_(),r=[],this.gopCache_.length=0,s.length=0,this.trigger("reset")},this.resetStream_=function(){re(t),n=void 0,a=void 0},this.getGopForFusion_=function(e){var i,n,a,r,s,o=1/0;for(s=0;s<this.gopCache_.length;s++)a=(r=this.gopCache_[s]).gop,t.pps&&ci(t.pps[0],r.pps[0])&&t.sps&&ci(t.sps[0],r.sps[0])&&(a.dts<t.timelineStartInfo.dts||(i=e.dts-a.dts-a.duration)>=-1e4&&i<=45e3&&(!n||o>i)&&(n=r,o=i));return n?n.gop:null},this.alignGopsAtStart_=function(t){var e,i,n,a,r,o,d,h;for(r=t.byteLength,o=t.nalCount,d=t.duration,e=i=0;e<s.length&&i<t.length&&(n=s[e],a=t[i],n.pts!==a.pts);)a.pts>n.pts?e++:(i++,r-=a.byteLength,o-=a.nalCount,d-=a.duration);return 0===i?t:i===t.length?null:((h=t.slice(i)).byteLength=r,h.duration=d,h.nalCount=o,h.pts=h[0].pts,h.dts=h[0].dts,h)},this.alignGopsAtEnd_=function(t){var e,i,n,a,r,o,d;for(e=s.length-1,i=t.length-1,r=null,o=!1;e>=0&&i>=0;){if(n=s[e],a=t[i],n.pts===a.pts){o=!0;break}n.pts>a.pts?e--:(e===s.length-1&&(r=i),i--)}if(!o&&null===r)return null;if(0===(d=o?i:r))return t;var h=t.slice(d),p=h.reduce((function(t,e){return t.byteLength+=e.byteLength,t.duration+=e.duration,t.nalCount+=e.nalCount,t}),{byteLength:0,duration:0,nalCount:0});return h.byteLength=p.byteLength,h.duration=p.duration,h.nalCount=p.nalCount,h.pts=h[0].pts,h.dts=h[0].dts,h},this.alignGopsWith=function(t){s=t}}).prototype=new Bt,(ai=function(t,e){this.numberOfTracks=0,this.metadataStream=e,void 0!==(t=t||{}).remux?this.remuxTracks=!!t.remux:this.remuxTracks=!0,"boolean"==typeof t.keepOriginalTimestamps?this.keepOriginalTimestamps=t.keepOriginalTimestamps:this.keepOriginalTimestamps=!1,this.pendingTracks=[],this.videoTrack=null,this.pendingBoxes=[],this.pendingCaptions=[],this.pendingMetadata=[],this.pendingBytes=0,this.emittedTracks=0,ai.prototype.init.call(this),this.push=function(t){return t.text?this.pendingCaptions.push(t):t.frames?this.pendingMetadata.push(t):(this.pendingTracks.push(t.track),this.pendingBytes+=t.boxes.byteLength,"video"===t.track.type&&(this.videoTrack=t.track,this.pendingBoxes.push(t.boxes)),void("audio"===t.track.type&&(this.audioTrack=t.track,this.pendingBoxes.unshift(t.boxes))))}}).prototype=new Bt,ai.prototype.flush=function(t){var e,i,n,a,r=0,s={captions:[],captionStreams:{},metadata:[],info:{}},o=0;if(this.pendingTracks.length<this.numberOfTracks){if("VideoSegmentStream"!==t&&"AudioSegmentStream"!==t)return;if(this.remuxTracks)return;if(0===this.pendingTracks.length)return this.emittedTracks++,void(this.emittedTracks>=this.numberOfTracks&&(this.trigger("done"),this.emittedTracks=0))}if(this.videoTrack?(o=this.videoTrack.timelineStartInfo.pts,oi.forEach((function(t){s.info[t]=this.videoTrack[t]}),this)):this.audioTrack&&(o=this.audioTrack.timelineStartInfo.pts,si.forEach((function(t){s.info[t]=this.audioTrack[t]}),this)),this.videoTrack||this.audioTrack){for(1===this.pendingTracks.length?s.type=this.pendingTracks[0].type:s.type="combined",this.emittedTracks+=this.pendingTracks.length,n=Q.initSegment(this.pendingTracks),s.initSegment=new Uint8Array(n.byteLength),s.initSegment.set(n),s.data=new Uint8Array(this.pendingBytes),a=0;a<this.pendingBoxes.length;a++)s.data.set(this.pendingBoxes[a],r),r+=this.pendingBoxes[a].byteLength;for(a=0;a<this.pendingCaptions.length;a++)(e=this.pendingCaptions[a]).startTime=Qt(e.startPts,o,this.keepOriginalTimestamps),e.endTime=Qt(e.endPts,o,this.keepOriginalTimestamps),s.captionStreams[e.stream]=!0,s.captions.push(e);for(a=0;a<this.pendingMetadata.length;a++)(i=this.pendingMetadata[a]).cueTime=Qt(i.pts,o,this.keepOriginalTimestamps),s.metadata.push(i);for(s.metadata.dispatchType=this.metadataStream.dispatchType,this.pendingTracks.length=0,this.videoTrack=null,this.pendingBoxes.length=0,this.pendingCaptions.length=0,this.pendingBytes=0,this.pendingMetadata.length=0,this.trigger("data",s),a=0;a<s.captions.length;a++)e=s.captions[a],this.trigger("caption",e);for(a=0;a<s.metadata.length;a++)i=s.metadata[a],this.trigger("id3Frame",i)}this.emittedTracks>=this.numberOfTracks&&(this.trigger("done"),this.emittedTracks=0)},ai.prototype.setRemux=function(t){this.remuxTracks=t},(ni=function(t){var e,i,n=this,a=!0;ni.prototype.init.call(this),t=t||{},this.baseMediaDecodeTime=t.baseMediaDecodeTime||0,this.transmuxPipeline_={},this.setupAacPipeline=function(){var a={};this.transmuxPipeline_=a,a.type="aac",a.metadataStream=new Ge.MetadataStream,a.aacStream=new ri,a.audioTimestampRolloverStream=new Ge.TimestampRolloverStream("audio"),a.timedMetadataTimestampRolloverStream=new Ge.TimestampRolloverStream("timed-metadata"),a.adtsStream=new je,a.coalesceStream=new ai(t,a.metadataStream),a.headOfPipeline=a.aacStream,a.aacStream.pipe(a.audioTimestampRolloverStream).pipe(a.adtsStream),a.aacStream.pipe(a.timedMetadataTimestampRolloverStream).pipe(a.metadataStream).pipe(a.coalesceStream),a.metadataStream.on("timestamp",(function(t){a.aacStream.setTimestamp(t.timeStamp)})),a.aacStream.on("data",(function(r){"timed-metadata"!==r.type&&"audio"!==r.type||a.audioSegmentStream||(i=i||{timelineStartInfo:{baseMediaDecodeTime:n.baseMediaDecodeTime},codec:"adts",type:"audio"},a.coalesceStream.numberOfTracks++,a.audioSegmentStream=new ii(i,t),a.audioSegmentStream.on("log",n.getLogTrigger_("audioSegmentStream")),a.audioSegmentStream.on("timingInfo",n.trigger.bind(n,"audioTimingInfo")),a.adtsStream.pipe(a.audioSegmentStream).pipe(a.coalesceStream),n.trigger("trackinfo",{hasAudio:!!i,hasVideo:!!e}))})),a.coalesceStream.on("data",this.trigger.bind(this,"data")),a.coalesceStream.on("done",this.trigger.bind(this,"done")),li(this,a)},this.setupTsPipeline=function(){var a={};this.transmuxPipeline_=a,a.type="ts",a.metadataStream=new Ge.MetadataStream,a.packetStream=new Ge.TransportPacketStream,a.parseStream=new Ge.TransportParseStream,a.elementaryStream=new Ge.ElementaryStream,a.timestampRolloverStream=new Ge.TimestampRolloverStream,a.adtsStream=new je,a.h264Stream=new di,a.captionStream=new Ge.CaptionStream(t),a.coalesceStream=new ai(t,a.metadataStream),a.headOfPipeline=a.packetStream,a.packetStream.pipe(a.parseStream).pipe(a.elementaryStream).pipe(a.timestampRolloverStream),a.timestampRolloverStream.pipe(a.h264Stream),a.timestampRolloverStream.pipe(a.adtsStream),a.timestampRolloverStream.pipe(a.metadataStream).pipe(a.coalesceStream),a.h264Stream.pipe(a.captionStream).pipe(a.coalesceStream),a.elementaryStream.on("data",(function(r){var s;if("metadata"===r.type){for(s=r.tracks.length;s--;)e||"video"!==r.tracks[s].type?i||"audio"!==r.tracks[s].type||((i=r.tracks[s]).timelineStartInfo.baseMediaDecodeTime=n.baseMediaDecodeTime):(e=r.tracks[s]).timelineStartInfo.baseMediaDecodeTime=n.baseMediaDecodeTime;e&&!a.videoSegmentStream&&(a.coalesceStream.numberOfTracks++,a.videoSegmentStream=new ei(e,t),a.videoSegmentStream.on("log",n.getLogTrigger_("videoSegmentStream")),a.videoSegmentStream.on("timelineStartInfo",(function(e){i&&!t.keepOriginalTimestamps&&(i.timelineStartInfo=e,a.audioSegmentStream.setEarliestDts(e.dts-n.baseMediaDecodeTime))})),a.videoSegmentStream.on("processedGopsInfo",n.trigger.bind(n,"gopInfo")),a.videoSegmentStream.on("segmentTimingInfo",n.trigger.bind(n,"videoSegmentTimingInfo")),a.videoSegmentStream.on("baseMediaDecodeTime",(function(t){i&&a.audioSegmentStream.setVideoBaseMediaDecodeTime(t)})),a.videoSegmentStream.on("timingInfo",n.trigger.bind(n,"videoTimingInfo")),a.h264Stream.pipe(a.videoSegmentStream).pipe(a.coalesceStream)),i&&!a.audioSegmentStream&&(a.coalesceStream.numberOfTracks++,a.audioSegmentStream=new ii(i,t),a.audioSegmentStream.on("log",n.getLogTrigger_("audioSegmentStream")),a.audioSegmentStream.on("timingInfo",n.trigger.bind(n,"audioTimingInfo")),a.audioSegmentStream.on("segmentTimingInfo",n.trigger.bind(n,"audioSegmentTimingInfo")),a.adtsStream.pipe(a.audioSegmentStream).pipe(a.coalesceStream)),n.trigger("trackinfo",{hasAudio:!!i,hasVideo:!!e})}})),a.coalesceStream.on("data",this.trigger.bind(this,"data")),a.coalesceStream.on("id3Frame",(function(t){t.dispatchType=a.metadataStream.dispatchType,n.trigger("id3Frame",t)})),a.coalesceStream.on("caption",this.trigger.bind(this,"caption")),a.coalesceStream.on("done",this.trigger.bind(this,"done")),li(this,a)},this.setBaseMediaDecodeTime=function(n){var a=this.transmuxPipeline_;t.keepOriginalTimestamps||(this.baseMediaDecodeTime=n),i&&(i.timelineStartInfo.dts=void 0,i.timelineStartInfo.pts=void 0,re(i),a.audioTimestampRolloverStream&&a.audioTimestampRolloverStream.discontinuity()),e&&(a.videoSegmentStream&&(a.videoSegmentStream.gopCache_=[]),e.timelineStartInfo.dts=void 0,e.timelineStartInfo.pts=void 0,re(e),a.captionStream.reset()),a.timestampRolloverStream&&a.timestampRolloverStream.discontinuity()},this.setAudioAppendStart=function(t){i&&this.transmuxPipeline_.audioSegmentStream.setAudioAppendStart(t)},this.setRemux=function(e){var i=this.transmuxPipeline_;t.remux=e,i&&i.coalesceStream&&i.coalesceStream.setRemux(e)},this.alignGopsWith=function(t){e&&this.transmuxPipeline_.videoSegmentStream&&this.transmuxPipeline_.videoSegmentStream.alignGopsWith(t)},this.getLogTrigger_=function(t){var e=this;return function(i){i.stream=t,e.trigger("log",i)}},this.push=function(t){if(a){var e=hi(t);e&&"aac"!==this.transmuxPipeline_.type?this.setupAacPipeline():e||"ts"===this.transmuxPipeline_.type||this.setupTsPipeline(),a=!1}this.transmuxPipeline_.headOfPipeline.push(t)},this.flush=function(){a=!0,this.transmuxPipeline_.headOfPipeline.flush()},this.endTimeline=function(){this.transmuxPipeline_.headOfPipeline.endTimeline()},this.reset=function(){this.transmuxPipeline_.headOfPipeline&&this.transmuxPipeline_.headOfPipeline.reset()},this.resetCaptions=function(){this.transmuxPipeline_.captionStream&&this.transmuxPipeline_.captionStream.reset()}}).prototype=new Bt;var gi={Transmuxer:ni,VideoSegmentStream:ei,AudioSegmentStream:ii,AUDIO_PROPERTIES:si,VIDEO_PROPERTIES:oi,generateSegmentTimingInfo:fi},mi=ue,yi=Ce.CaptionStream,Si=function(t,e){for(var i=t,n=0;n<e.length;n++){var a=e[n];if(i<a.size)return a;i-=a.size}return null},vi=function(t,e){var i=nt(t,["moof","traf"]),n=nt(t,["mdat"]),a={},r=[];return n.forEach((function(t,e){var n=i[e];r.push({mdat:t,traf:n})})),r.forEach((function(t){var i,n=t.mdat,r=t.traf,s=nt(r,["tfhd"]),o=pt(s[0]),d=o.trackId,h=nt(r,["tfdt"]),p=h.length>0?gt(h[0]).baseMediaDecodeTime:0,u=nt(r,["trun"]);e===d&&u.length>0&&(i=function(t,e,i){var n,a,r,s,o=new DataView(t.buffer,t.byteOffset,t.byteLength),d={logs:[],seiNals:[]};for(a=0;a+4<t.length;a+=r)if(r=o.getUint32(a),a+=4,!(r<=0))switch(31&t[a]){case 6:var h=t.subarray(a+1,a+1+r),p=Si(a,e);if(n={nalUnitType:"sei_rbsp",size:r,data:h,escapedRBSP:mi(h),trackId:i},p)n.pts=p.pts,n.dts=p.dts,s=p;else{if(!s){d.logs.push({level:"warn",message:"We've encountered a nal unit without data at "+a+" for trackId "+i+". See mux.js#223."});break}n.pts=s.pts,n.dts=s.dts}d.seiNals.push(n)}return d}(n,function(t,e,i){var n=e,a=i.defaultSampleDuration||0,r=i.defaultSampleSize||0,s=i.trackId,o=[];return t.forEach((function(t){var e=lt(t).samples;e.forEach((function(t){void 0===t.duration&&(t.duration=a),void 0===t.size&&(t.size=r),t.trackId=s,t.dts=n,void 0===t.compositionTimeOffset&&(t.compositionTimeOffset=0),"bigint"==typeof n?(t.pts=n+F.default.BigInt(t.compositionTimeOffset),n+=F.default.BigInt(t.duration)):(t.pts=n+t.compositionTimeOffset,n+=t.duration)})),o=o.concat(e)})),o}(u,p,o),d),a[d]||(a[d]={seiNals:[],logs:[]}),a[d].seiNals=a[d].seiNals.concat(i.seiNals),a[d].logs=a[d].logs.concat(i.logs))})),a};return{generator:Q,probe:Ut,Transmuxer:gi.Transmuxer,AudioSegmentStream:gi.AudioSegmentStream,VideoSegmentStream:gi.VideoSegmentStream,CaptionParser:function(){var t,e,i,n,a,r,s=!1;this.isInitialized=function(){return s},this.init=function(e){t=new yi,s=!0,r=!!e&&e.isPartial,t.on("data",(function(t){t.startTime=t.startPts/n,t.endTime=t.endPts/n,a.captions.push(t),a.captionStreams[t.stream]=!0})),t.on("log",(function(t){a.logs.push(t)}))},this.isNewInit=function(t,e){return!(t&&0===t.length||e&&"object"==typeof e&&0===Object.keys(e).length)&&(i!==t[0]||n!==e[i])},this.parse=function(t,r,s){var o;if(!this.isInitialized())return null;if(!r||!s)return null;if(this.isNewInit(r,s))i=r[0],n=s[i];else if(null===i||!n)return e.push(t),null;for(;e.length>0;){var d=e.shift();this.parse(d,r,s)}return(o=function(t,e,i){if(null===e)return null;var n=vi(t,e)[e]||{};return{seiNals:n.seiNals,logs:n.logs,timescale:i}}(t,i,n))&&o.logs&&(a.logs=a.logs.concat(o.logs)),null!==o&&o.seiNals?(this.pushNals(o.seiNals),this.flushStream(),a):a.logs.length?{logs:a.logs,captions:[],captionStreams:[]}:null},this.pushNals=function(e){if(!this.isInitialized()||!e||0===e.length)return null;e.forEach((function(e){t.push(e)}))},this.flushStream=function(){if(!this.isInitialized())return null;r?t.partialFlush():t.flush()},this.clearParsedCaptions=function(){a.captions=[],a.captionStreams={},a.logs=[]},this.resetCaptionStream=function(){if(!this.isInitialized())return null;t.reset()},this.clearAllCaptions=function(){this.clearParsedCaptions(),this.resetCaptionStream()},this.reset=function(){e=[],i=null,n=null,a?this.clearParsedCaptions():a={captions:[],captionStreams:{},logs:[]},this.resetCaptionStream()},this.reset()}}}));
    /* END VENDORED MUX.JS */
    return module.exports;
  };
  const hlsAttributes = text => {
    const result = Object.create(null);
    for (const token of text.match(/(?:[^,"\r\n]|"[^"\r\n]*")+/g) || []) {
      const match = token.trim().match(/^([A-Z0-9-]+)=(?:"([^"\r\n]*)"|([^"\r\n]+))$/);
      if (!match || Object.hasOwn(result, match[1])) throw new Error("HLS 속성이 올바르지 않습니다.");
      result[match[1]] = match[2] ?? match[3];
    }
    return result;
  };
  const hlsUrl = (uri, base) => {
    if (!uri || uri.includes("{$")) throw new Error("비어 있거나 변수를 사용하는 HLS 주소는 지원하지 않습니다.");
    const parsed = new URL(uri, base);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error("HLS 조각은 인증 정보가 없는 HTTP·HTTPS 주소여야 합니다.");
    }
    return parsed.href;
  };
  const hlsPlaylist = (text, base) => {
    const lines = text.replace(/^\ufeff/, "").trim().split(/\r?\n/).map(line => line.trim());
    if (lines[0] !== "#EXTM3U") throw new Error("HLS 재생목록이 아닙니다.");
    const variants = [], segments = [], separateAudio = new Set();
    let variant = null, duration = null, ended = false;
    for (const line of lines.slice(1)) {
      if (!line) continue;
      if (/^#EXT-X-(?:SESSION-KEY|BYTERANGE|MAP|DISCONTINUITY(?:-SEQUENCE)?|GAP|PART(?:-INF)?|SKIP|PRELOAD-HINT|DEFINE)(?::|$)/.test(line)) {
        throw new Error("브라우저 MP4 저장은 연속된 TS 방식의 VOD만 지원합니다. 암호화·분할 음성·fMP4·라이브 등은 지원하지 않습니다.");
      }
      if (line.startsWith("#EXT-X-KEY:")) {
        if (hlsAttributes(line.slice(11)).METHOD !== "NONE") throw new Error("암호화된 HLS는 콘솔 MP4 저장을 지원하지 않습니다.");
      } else if (line.startsWith("#EXT-X-MEDIA:")) {
        const attr = hlsAttributes(line.slice(13));
        if (attr.TYPE === "AUDIO" && attr.URI) separateAudio.add(attr["GROUP-ID"]);
      } else if (line.startsWith("#EXT-X-STREAM-INF:")) {
        if (variant || duration !== null) throw new Error("HLS 재생목록의 항목 순서가 올바르지 않습니다.");
        variant = hlsAttributes(line.slice(18));
      } else if (line.startsWith("#EXTINF:")) {
        if (duration !== null || variant) throw new Error("HLS 영상 조각 주소가 누락됐습니다.");
        duration = Number(line.slice(8).split(",")[0]);
        if (!Number.isFinite(duration) || duration <= 0) throw new Error("HLS 영상 조각의 길이가 올바르지 않습니다.");
      } else if (line === "#EXT-X-ENDLIST") {
        ended = true;
      } else if (!line.startsWith("#")) {
        if (ended) throw new Error("HLS 종료 표시 뒤에 영상 조각이 있습니다.");
        if (variant) {
          variants.push({ url: hlsUrl(line, base), ...variant }); variant = null;
        } else if (duration !== null) {
          segments.push({ url: hlsUrl(line, base), duration }); duration = null;
        } else throw new Error("HLS 영상 조각의 길이 정보가 없습니다.");
      }
      if (variants.length > 128 || segments.length > 1000) throw new Error("HLS 재생목록 항목 수 제한을 넘었습니다.");
    }
    if (variant || duration !== null || variants.length && segments.length) throw new Error("HLS 재생목록이 불완전합니다.");
    if (variants.length) {
      const supported = variants.filter(v => !separateAudio.has(v.AUDIO) &&
        (!v.CODECS || v.CODECS.split(",").every(codec => /^(?:avc[13]\.[\da-f]+|mp4a\.40\.\d+)$/i.test(codec.trim()))));
      supported.sort((a, b) => (Number(b.BANDWIDTH) || 0) - (Number(a.BANDWIDTH) || 0));
      if (!supported.length) throw new Error("H.264·AAC가 한 목록에 있는 HLS만 콘솔에서 MP4로 저장할 수 있습니다.");
      return { variant: supported[0].url };
    }
    if (!ended) throw new Error("라이브·진행 중인 HLS는 지원하지 않습니다. 완료된 VOD 목록이 필요합니다.");
    if (!segments.length) throw new Error("HLS 재생목록에 영상 조각이 없습니다.");
    return { segments };
  };
  const readHls = async (url, first, options, signal) => {
    const playlistLimit = Math.min(options.maxFileBytes, 2 * 1024 ** 2), seen = new Set();
    let source = first, list;
    for (let depth = 0; depth < 5; depth++) {
      if (signal.aborted) throw new Error("사용자가 중단했습니다.");
      const base = hlsUrl(source.resolvedUrl || url, url);
      if (seen.has(base)) throw new Error("HLS 재생목록이 순환합니다.");
      seen.add(base);
      if (source.size > playlistLimit) throw new Error("HLS 재생목록 크기 제한을 넘었습니다.");
      list = hlsPlaylist(await source.blob.text(), base);
      if (list.segments) break;
      if (depth === 4) throw new Error("HLS 재생목록의 중첩 제한을 넘었습니다.");
      url = list.variant;
      source = await readMedia(url, { ...options, maxFileBytes: playlistLimit }, signal);
      if (source.extension !== ".m3u8") throw new Error("HLS 하위 재생목록이 아닙니다.");
    }
    if (!list?.segments) throw new Error("HLS 재생목록의 중첩 제한을 넘었습니다.");
    const mux = createHlsMux(), transmuxer = new mux.Transmuxer({ remux: true });
    const parts = [];
    let size = 0, downloaded = 0, crc = 0xffffffff, init = null, trackKey = null, outputs = 0;
    let width = 0, height = 0, hasAudio = false, muxError = null;
    const append = bytes => {
      size += bytes.byteLength;
      if (size > options.maxFileBytes) throw new Error("합친 MP4의 크기 제한을 넘었습니다.");
      crc = crcUpdate(crc, bytes); parts.push(bytes.slice());
    };
    transmuxer.on("error", error => { muxError = error instanceof Error ? error : new Error(String(error)); });
    transmuxer.on("data", segment => {
      const tracks = mux.probe.tracks(segment.initSegment);
      if (!tracks.some(track => track.type === "video" && /^avc[13]\./.test(track.codec)) ||
          tracks.some(track => track.type === "audio" && !/^mp4a\.40\./.test(track.codec))) {
        throw new Error("TS 영상 조각에서 지원하는 H.264 영상을 확인하지 못했습니다.");
      }
      const key = JSON.stringify(tracks);
      if (trackKey !== null && (key !== trackKey || init.length !== segment.initSegment.length ||
          init.some((byte, i) => byte !== segment.initSegment[i]))) {
        throw new Error("HLS 중간에 코덱·해상도·트랙 정보가 바뀌었습니다.");
      }
      if (!init) { init = segment.initSegment.slice(); trackKey = key; append(init); }
      if (!segment.data.byteLength) throw new Error("MP4 영상 조각이 비어 있습니다.");
      append(segment.data); outputs++;
      width = segment.info?.width || width; height = segment.info?.height || height;
      hasAudio ||= tracks.some(track => track.type === "audio");
    });
    try {
      for (const [index, segment] of list.segments.entries()) {
        if (signal.aborted) throw new Error("사용자가 중단했습니다.");
        const data = await readMedia(segment.url, { ...options, maxFileBytes: options.maxFileBytes - downloaded }, signal, false);
        downloaded += data.size;
        const bytes = new Uint8Array(await data.blob.arrayBuffer());
        if (!bytes.length || bytes.length % 188 !== 0) throw new Error(`HLS ${index + 1}번째 TS 조각이 손상됐거나 지원하지 않는 형식입니다.`);
        for (let offset = 0; offset < bytes.length; offset += 188) {
          if (bytes[offset] !== 0x47 || bytes[offset + 1] & 0x80) throw new Error(`HLS ${index + 1}번째 TS 조각의 패킷이 올바르지 않습니다.`);
        }
        const before = outputs;
        transmuxer.push(bytes); transmuxer.flush();
        if (muxError) throw muxError;
        if (outputs === before) throw new Error(`HLS ${index + 1}번째 조각에서 MP4 영상을 만들지 못했습니다.`);
        console.log(`HLS 영상 조각 ${index + 1}/${list.segments.length}`);
      }
      if (signal.aborted) throw new Error("사용자가 중단했습니다.");
      if (!init || !width || !height) throw new Error("완성된 MP4의 영상 정보를 확인하지 못했습니다.");
      return { blob: new Blob(parts, { type: "video/mp4" }), size, crc: (crc ^ 0xffffffff) >>> 0,
        extension: ".mp4", httpStatus: first.httpStatus, contentType: "video/mp4", width, height, hasAudio,
        segments: list.segments.length, playlistUrl: first.resolvedUrl || url, format: "fragmented-mp4",
        playlistDurationSeconds: list.segments.reduce((sum, segment) => sum + segment.duration, 0) };
    } finally { transmuxer.dispose(); }
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
            visible: row?.visible || false, message: "원본 영상 주소 미확인. 페이지·리뷰 응답이 썸네일만 제공하면 재생 없이 추출할 수 없습니다." };
        });
    },
    get ready() { return reviewReady; },
    get reviewCollection() {
      return { pendingResponses: reviewTasks.size, refreshing: Boolean(reviewRun),
        observedLists: [...reviewRequests.values()].filter(r => r.list && r.method === "GET").length,
        limitsReached: [...reviewLimits], errors: [...reviewErrors].map(([url, message]) => ({ url, message })) };
    },
    async collectReviewVideos({ refresh = true } = {}) {
      this.scan({ quiet: true });
      if (refresh && this.pendingVideos.length) await refreshReviewResponses();
      await waitReviewTasks();
      linkReviewPositions();
      const result = { videos: this.videos, pendingVideos: this.pendingVideos, ...this.reviewCollection };
      console.log(`재생 없이 리뷰 데이터 확인: 영상·임베드 ${result.videos.length}개 / 원본 미확인 리뷰 ${result.pendingVideos.length}개 / 응답 대기 ${result.pendingResponses}개`);
      return result;
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
      // 초기 DOM 스캔 결과에 원본이 없는 경우에만 관찰된 리뷰 목록을 재조회합니다.
      reviewReady = (async () => {
        if (this.pendingVideos.length) await refreshReviewResponses();
        await waitReviewTasks();
        linkReviewPositions();
        return { videos: this.videos, pendingVideos: this.pendingVideos, ...this.reviewCollection };
      })();
      console.log("리뷰 데이터·영상 감시 시작. 자동 수집 완료 대기: await mediaGrab.ready. 종료: mediaGrab.stopWatching()");
      return { watching, intervalMs };
    },
    stopWatching() {
      watching = false; watchEpoch++;
      if (pollTimer !== null) window.clearInterval?.(pollTimer);
      pollTimer = null;
      for (const cleanup of cleanups) { try { cleanup(); } catch {} }
      cleanups.clear(); watchedRoots = new Map(); watchedWindows = new Map();
      reviewRequests.clear(); reviewFetchers.clear(); reviewRun = null;
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
    downloadHls(options = {}) {
      return this.download({ ...options, streamsOnly: true, hls: "mp4" });
    },
    async download({ visibleOnly = false, start = 1, end = Infinity, maxFileMB = 256,
        maxZipMB = 256, timeoutMs = 30000, credentials = "same-origin", streamsOnly = false, hls = "playlist" } = {}) {
      if (downloadController) throw new Error("이미 다운로드 중입니다. 중단하려면 mediaGrab.stopDownload()를 실행하세요.");
      this.scan({ quiet: true });
      if (![maxFileMB, maxZipMB].every(x => Number.isFinite(x) && x > 0 && x <= 1024) ||
          !Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(start) || start < 1 ||
          !(end === Infinity || Number.isInteger(end) && end >= start) ||
          !["same-origin", "omit", "include"].includes(credentials) || typeof streamsOnly !== "boolean" ||
          !["playlist", "mp4"].includes(hls)) throw new Error("다운로드 옵션을 확인하세요.");
      const rows = (visibleOnly ? this.visibleRows : this.rows).filter(row => row.order >= start && row.order <= end &&
        (!streamsOnly || row.type === "STREAM"));
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
              const firstOptions = hls === "mp4" && row.type === "STREAM" ?
                { ...options, maxFileBytes: Math.min(options.maxFileBytes, 2 * 1024 ** 2) } : options;
              let data = await readMedia(row.url, firstOptions, signal);
              if (hls === "mp4" && data.extension === ".m3u8") data = await readHls(row.url, data, options, signal);
              if (hls === "mp4" && data.extension === ".mpd") throw new Error("DASH 영상은 콘솔 MP4 저장을 지원하지 않습니다.");
              if (entries.length && (partBytes + data.size > zipLimit || entries.length >= 10000)) flush();
              const filename = `${String(row.order).padStart(width, "0")}${data.extension}`;
              entries.push({ name: filename, ...data }); partBytes += data.size;
              Object.assign(result, { status: [".m3u8", ".mpd"].includes(data.extension) ? "playlist" : "packed",
                filename, bytes: data.size, httpStatus: data.httpStatus, contentType: data.contentType });
              if (data.segments) Object.assign(result, { segments: data.segments, format: data.format,
                width: data.width, height: data.height, hasAudio: data.hasAudio,
                playlistUrl: data.playlistUrl, playlistDurationSeconds: data.playlistDurationSeconds,
                message: `HLS 영상 조각 ${data.segments}개를 MP4로 합쳤습니다.` });
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
        pendingVideos: this.pendingVideos,
        reviewCollection: this.reviewCollection
      };
    },
    export(options = {}) {
      const manifest = this.getManifest(options);
      if (manifest.reviewCollection.refreshing || manifest.reviewCollection.pendingResponses) console.log("리뷰 응답 수집 중입니다. await mediaGrab.collectReviewVideos() 후 다시 내보내면 최신 결과를 포함합니다.");
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
      reviewPropsVisited = new WeakSet(); reviewFibersVisited = new WeakSet();
      blockedFrames.clear();
      for (const row of found.values()) Object.assign(row, { position: null, visible: false, element: Infinity });
      const win = document.defaultView || window;
      walk(document, new Set(), {
        x: Number(win.scrollX) || Number(document.documentElement?.scrollLeft) || 0,
        y: Number(win.scrollY) || Number(document.documentElement?.scrollTop) || 0,
        sx: 1, sy: 1, visible: true, clip: null
      });
      linkReviewPositions();
      const rows = this.rows;
      if (quiet) return rows;
      console.table(rows);
      console.log(`총 ${found.size}개 URL (페이지 좌표 순서, 위치 미확인 주소는 뒤쪽)\n${rows.map(r => r.url).join("\n")}`);
      console.log(`표시 요소의 선택 주소 ${this.visibleUrls.length}개: copy(mediaGrab.visibleUrls.join('\\n'))`);
      console.log("일괄 다운로드용 목록 파일 저장: mediaGrab.export()");
      console.log("설치 없이 브라우저에서 ZIP 다운로드: await mediaGrab.download()");
      console.log("설치 없이 HLS 리뷰 영상을 MP4 ZIP으로 저장: await mediaGrab.downloadHls()");
      if (excluded.size) console.log(`미디어에서 제외한 통계·이벤트 주소 ${excluded.size}개: mediaGrab.excludedRows`);
      if (blockedFrames.size) console.log("접근할 수 없는 iframe:", this.blockedFrames);
      console.log(`외부 영상 ${this.embeds.length}개 / 원본 영상·재생목록 ${this.videos.length - this.embeds.length}개 / 미확인 리뷰 영상 ${this.pendingVideos.length}개`);
      if (this.pendingVideos.length) console.log("미확인 리뷰 영상: mediaGrab.pendingVideos. await mediaGrab.collectReviewVideos()로 리뷰 데이터를 확인하세요.");
      return rows;
    }
  };
  window.mediaGrab.watch({ quiet: false });
})();
