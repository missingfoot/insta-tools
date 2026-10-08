// Insta Tools: download buttons.
// Adds a download button to the top right corner of post images, gallery
// images, videos and reels. Runs in the page's own world, because the video
// address is read from Instagram's React objects.
//
// Images are saved straight from the page. Videos and reels go to the local
// helper first (yt-dlp, full quality). If the helper is missing or fails, the
// complete MP4 the page already has (usually 720p) is saved instead.

(function () {
  'use strict';
  if (window.__igImageDownloadLoaded) return;
  window.__igImageDownloadLoaded = true;

  const BUTTON_CLASS = 'igdl-btn';
  const CHANNEL = 'insta-tools'; // must match content/bridge.js
  const MIN_SIZE = 200; // rendered px. Smaller media are avatars and thumbnails.
  // Post images live in the feed (<article>), on a post or Reels page (<main>) or in the post pop-up (dialog).
  // Videos are taken from anywhere: a reel opened from the home feed plays in
  // an overlay of plain divs outside all three, with the feed still in <main> underneath.
  const MEDIA_SELECTOR = [...['main', 'article', '[role="dialog"]'].map((root) => `${root} img`), 'video'].join(', ');
  // Feed reels are wrapped in a full-size link to /reels/ID/. That link is the
  // player itself, not a grid tile (tiles link to /p/ID/ or /username/reel/ID/).
  const PLAYER_LINK_RE = /^\/reels\/([A-Za-z0-9_-]+)\/?$/;
  const SKIP_PATHS = /^\/(direct|stories)(\/|$)/;
  // Author links are /username/ in the feed and /username/reels/ on the Reels page.
  const PROFILE_PATH_RE = /^\/([A-Za-z0-9_.]+)\/(?:reels\/)?$/;
  const NOT_PROFILES = new Set(['explore', 'reels', 'reel', 'p', 'direct', 'stories', 'accounts', 'your_activity']);
  const POST_PATH_RE = /^(?:\/[^/]+)?\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)\/?$/;
  const POST_LINK_SELECTOR = 'a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"]';
  const EXTENSIONS = {
    'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png', 'image/heic': 'heic', 'image/avif': 'avif',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  };

  const ARROW = 'M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14';
  const CHECK = 'M5 12.5l4.5 4.5L19 7.5';
  const ICONS = { idle: ARROW, busy: ARROW, done: CHECK, fallback: CHECK, error: 'M6 6l12 12M18 6L6 18' };

  const isVideo = (media) => media.tagName === 'VIDEO';

  // ---------- Finding media ----------

  // Grid tiles and avatars sit inside links, post media does not, except for feed reels.
  function isPostMedia(media) {
    const link = media.closest('a');
    if (link && !(isVideo(media) && PLAYER_LINK_RE.test(link.pathname))) return false;
    if (media.offsetWidth < MIN_SIZE || media.offsetHeight < MIN_SIZE) return false;
    return isVideo(media) || /^https?:/.test(media.currentSrc || media.src);
  }

  // The media is wrapped in a stack of same-sized divs, with click-catching
  // overlays as siblings somewhere up that stack. The button has to sit above
  // all of them, so take the outermost positioned wrapper that still matches
  // the media's size.
  function frameFor(media) {
    const box = media.getBoundingClientRect();
    let frame = null;
    let node = media.parentElement;
    for (let depth = 0; node && depth < 12; depth++, node = node.parentElement) {
      if (node.tagName === 'LI' || node.tagName === 'UL') break;
      const b = node.getBoundingClientRect();
      if (Math.abs(b.width - box.width) > 2 || Math.abs(b.height - box.height) > 2) break;
      if (getComputedStyle(node).position !== 'static') frame = node;
    }
    // A video carries a poster image in the same frame. The video gets the button, not the poster.
    if (frame && !isVideo(media) && frame.querySelector('video')) return null;
    return frame;
  }

  function mediaIn(frame) {
    const all = [...frame.querySelectorAll('video, img')].filter(isPostMedia);
    return all.find(isVideo) || all[0];
  }

  // Some layouts put Instagram's own "More options" control in the top right
  // of the media. Drop the button below it when that is the case.
  function place(btn, frame, media) {
    const box = frame.getBoundingClientRect();
    const target = { left: box.right - 44, right: box.right - 12, top: box.top + 12, bottom: box.top + 44 };
    const scope = frame.closest('article') || frame;
    const blocked = [...scope.querySelectorAll('[role="button"], button, a')].some((el) => {
      if (el === btn) return false;
      const r = el.getBoundingClientRect();
      if (!r.width || r.width > 100 || r.height > 100) return false; // skip the full-size player overlay
      return r.left < target.right && r.right > target.left && r.top < target.bottom && r.bottom > target.top;
    });
    btn.style.top = blocked ? '52px' : '';
    // The tooltip shows what the last download did, until the next one.
    const label = btn.dataset.note || (isVideo(media) ? 'Download video' : 'Download image');
    if (btn.title !== label) {
      btn.title = label;
      btn.setAttribute('aria-label', label);
    }
  }

  function scan() {
    // Gallery slides and feed posts are recycled as you scroll. Drop buttons whose media has gone.
    for (const btn of document.querySelectorAll(`.${BUTTON_CLASS}`)) {
      const media = mediaIn(btn.parentElement);
      if (media) place(btn, btn.parentElement, media);
      else btn.remove();
    }
    if (SKIP_PATHS.test(location.pathname)) return;
    for (const media of document.querySelectorAll(MEDIA_SELECTOR)) {
      if (!isPostMedia(media)) continue;
      const frame = frameFor(media);
      if (!frame || frame.querySelector(`:scope > .${BUTTON_CLASS}`)) continue;
      const btn = makeButton();
      frame.append(btn);
      place(btn, frame, media);
    }
  }

  // ---------- Sources ----------

  // Instagram normally puts the full size image straight in src. Where it uses
  // srcset instead, take the widest candidate.
  function imageSource(img) {
    const candidates = (img.srcset || '').split(',')
      .map((part) => part.trim().split(/\s+/))
      .filter(([url, width]) => url && /^\d+w$/.test(width || ''))
      .sort((a, b) => parseInt(b[1], 10) - parseInt(a[1], 10));
    return candidates.length ? candidates[0][0] : img.currentSrc || img.src;
  }

  // A playing video's src is a blob: stream that cannot be saved. The player
  // component a few levels up in React holds the address of a complete MP4
  // (picture and sound in one file), so read it from there.
  function videoSource(video) {
    const key = Object.keys(video).find((k) => k.startsWith('__reactFiber$'));
    let fiber = key ? video[key] : null;
    for (let depth = 0; fiber && depth < 40; depth++, fiber = fiber.return) {
      const players = fiber.memoizedProps && fiber.memoizedProps.implementations;
      if (!Array.isArray(players)) continue;
      for (const player of players) {
        const data = player && player.data;
        if (data && (data.hdSrc || data.sdSrc)) return data.hdSrc || data.sdSrc;
      }
    }
    const direct = video.currentSrc || video.src;
    return /^https?:/.test(direct) ? direct : null;
  }

  // ---------- File name ----------

  function profileLinks(node) {
    const found = [];
    for (const a of node.querySelectorAll('a[href]')) {
      const m = PROFILE_PATH_RE.exec(a.pathname);
      if (m && !NOT_PROFILES.has(m[1]) && a.getBoundingClientRect().width) found.push({ a, user: m[1] });
    }
    return found;
  }

  // The author is the highest profile link in the nearest block around the
  // media. Links inside an image frame are tagged people, so those are skipped.
  // A video can have its header laid over it, so there they count.
  function authorOf(media, frame) {
    for (let node = isVideo(media) ? frame : frame.parentElement; node && node !== document.body; node = node.parentElement) {
      const links = profileLinks(node).filter(({ a }) => isVideo(media) || !frame.contains(a));
      if (!links.length) continue;
      links.sort((x, y) => x.a.getBoundingClientRect().top - y.a.getBoundingClientRect().top);
      return links[0].user;
    }
    return 'instagram';
  }

  function shortcodeOf(frame) {
    const fromAddress = POST_PATH_RE.exec(location.pathname);
    if (fromAddress) return fromAddress[1];
    const player = frame.closest('a');
    const fromPlayer = player && PLAYER_LINK_RE.exec(player.pathname);
    if (fromPlayer) return fromPlayer[1];
    const root = frame.closest('article, [role="dialog"]') || frame.closest('main') || document.body;
    for (const a of root.querySelectorAll(POST_LINK_SELECTOR)) {
      const m = POST_PATH_RE.exec(a.pathname);
      if (m) return m[1];
    }
    return null;
  }

  function fileName(media, frame, url, mimeType) {
    // Gallery slides are laid out with translateX(index * width).
    let index = '';
    const slide = media.closest('li');
    const shift = slide && /translateX\((-?[\d.]+)px\)/.exec(slide.style.transform);
    if (shift && slide.offsetWidth) index = `_${Math.round(parseFloat(shift[1]) / slide.offsetWidth) + 1}`;

    const fromUrl = (/\.([a-z0-9]{3,4})$/i.exec(new URL(url, location.href).pathname) || [])[1];
    const ext = EXTENSIONS[mimeType] || fromUrl || (isVideo(media) ? 'mp4' : 'jpg');
    return `${authorOf(media, frame)}_${shortcodeOf(frame) || Date.now()}${index}.${ext}`;
  }

  // ---------- Helper (yt-dlp on this computer) ----------

  // The page cannot reach extension APIs, so the request goes to
  // content/bridge.js by window message. No "ack" within a moment means the
  // bridge is not there (for example when this file runs as a plain userscript).
  let requestCount = 0;
  function askHelper(payload) {
    return new Promise((resolve) => {
      const id = `${Date.now()}-${++requestCount}`;
      let acked = false;
      const stop = (result) => {
        window.removeEventListener('message', onMessage);
        resolve(result);
      };
      function onMessage(event) {
        const msg = event.data;
        if (event.source !== window || !msg || msg.channel !== CHANNEL || msg.id !== id) return;
        if (msg.type === 'ack') acked = true;
        else if (msg.type === 'result') stop(msg.result || { ok: false, error: 'Empty reply from the helper' });
      }
      window.addEventListener('message', onMessage);
      window.postMessage({ channel: CHANNEL, type: 'request', id, payload }, location.origin);
      setTimeout(() => { if (!acked) stop({ ok: false, error: 'Extension bridge not available' }); }, 800);
    });
  }

  // Amber and red results are listed in the toolbar popup, so the reason can
  // be read after the tooltip is gone. Only the path is sent, never the query.
  function reportProblem(state, note, frame) {
    askHelper({ action: 'report', state, note, code: shortcodeOf(frame) || '', page: location.pathname });
  }

  // ---------- Downloading ----------

  async function saveFromPage(media, frame) {
    const url = isVideo(media) ? videoSource(media) : imageSource(media);
    if (!url) throw new Error('No downloadable file found for this media');
    // The CDN is a different origin, so a plain download link would just open
    // the file. Fetch it and save the bytes from a blob instead.
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = fileName(media, frame, url, blob.type);
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 30000);
  }

  // Returns the button state to show and a note for its tooltip.
  async function download(media, frame) {
    let helperProblem = '';
    // yt-dlp fetches a whole post, so it is only used where the post is one
    // video. A video slide inside a gallery is saved from the page.
    if (isVideo(media) && !media.closest('li')) {
      const code = shortcodeOf(frame);
      if (code) {
        const result = await askHelper({ action: 'download', code, name: `${authorOf(media, frame)}_${code}` });
        if (result.ok) return { state: 'done', note: `Saved ${result.size || 'full quality'} with yt-dlp: ${result.file}` };
        helperProblem = String(result.error || 'Helper unavailable').slice(0, 300);
      }
    }
    await saveFromPage(media, frame);
    if (helperProblem) return { state: 'fallback', note: `Saved the page's own MP4 (usually 720p). Helper: ${helperProblem}` };
    return { state: 'done', note: '' };
  }

  // ---------- Button ----------

  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    .${BUTTON_CLASS} { position: absolute; top: 12px; right: 12px; z-index: 10; width: 32px; height: 32px; padding: 0;
      border: 0; border-radius: 50%; background: rgba(0, 0, 0, .55); color: #fff; cursor: pointer; opacity: .8;
      display: flex; align-items: center; justify-content: center; transition: opacity .15s, background .15s; }
    .${BUTTON_CLASS}:hover { opacity: 1; background: rgba(0, 0, 0, .8); }
    .${BUTTON_CLASS} svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2;
      stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
    .${BUTTON_CLASS}[data-state="busy"] { cursor: progress; opacity: 1; }
    .${BUTTON_CLASS}[data-state="busy"] svg { animation: igdl-bob .5s ease-in-out infinite alternate; }
    .${BUTTON_CLASS}[data-state="done"] { background: #1f9d55; opacity: 1; }
    .${BUTTON_CLASS}[data-state="fallback"] { background: #c77700; opacity: 1; }
    .${BUTTON_CLASS}[data-state="error"] { background: #d93025; opacity: 1; }
    @keyframes igdl-bob { from { transform: translateY(-2px); } to { transform: translateY(2px); } }
  `);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

  function setState(btn, state) {
    btn.dataset.state = state;
    btn.querySelector('path').setAttribute('d', ICONS[state]);
  }

  function makeButton() {
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.append(document.createElementNS(svgNs, 'path'));
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = BUTTON_CLASS;
    btn.append(svg);
    setState(btn, 'idle');

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.dataset.state === 'busy') return;
      const frame = btn.parentElement;
      const media = mediaIn(frame);
      if (!media) return;
      setState(btn, 'busy');
      btn.dataset.note = 'Downloading...';
      // Green: saved (full quality for videos). Amber: saved, but only the page's MP4. Red: nothing saved.
      // Amber and red stay a little longer so the tooltip can be read.
      let hold = 1500;
      try {
        const { state, note } = await download(media, frame);
        setState(btn, state);
        btn.dataset.note = note;
        if (state === 'fallback') {
          hold = 4000;
          reportProblem(state, note, frame);
        }
      } catch (err) {
        console.error('[Insta Tools]', err);
        setState(btn, 'error');
        btn.dataset.note = `Download failed: ${err.message}`;
        hold = 4000;
        reportProblem('error', btn.dataset.note, frame);
      }
      setTimeout(() => setState(btn, 'idle'), hold);
    });
    // Keep Instagram from treating a press on the button as a like, a pause, a tag toggle or a swipe.
    for (const type of ['dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart']) {
      btn.addEventListener(type, (e) => e.stopPropagation());
    }
    return btn;
  }

  // ---------- Start ----------

  scan();
  setInterval(scan, 500);
})();
