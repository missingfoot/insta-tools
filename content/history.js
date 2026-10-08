(function () {
  'use strict';
  if (window.__igHistoryLoaded) return;
  window.__igHistoryLoaded = true;

  const ID = '[A-Za-z0-9_-]+';
  // Tile links: /p/ID/, /reel/ID/, /reels/ID/ and the /username/reel/ID/ form used on profiles.
  const LINK_RE = new RegExp(`^(?:/[^/]+)?/(p|reel|reels)/(${ID})/?$`);
  // A post opened in a modal over a grid. The source underneath stays the live one.
  const MODAL_RE = new RegExp(`^(?:/[^/]+)?/(?:p|reel)/${ID}/?$`);
  // The Reels feed has no reel links in the DOM. The only trace of the reel
  // on screen is the address bar, which Instagram rewrites as you scroll.
  const REELS_FEED_RE = new RegExp(`^/reels/(${ID})/?$`);
  const LINK_SELECTOR = 'a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"]';
  // Grid tiles always link to /p/ID/, so a reel is identified by its "Clip"
  // badge. The path prefix is a fallback for non-English UIs.
  const CLIP_LABEL = 'Clip';
  const CLIP_PATH_PREFIX = 'M22.942 7.464';
  // A profile's Reels tab. Its tiles link to /username/reel/ID/, so tiles left
  // over from the previous profile can be told apart while the page swaps.
  const PROFILE_REELS_RE = /^\/([A-Za-z0-9._]+)\/reels\/?$/;
  const NOT_PROFILES = new Set(['explore', 'accounts', 'direct', 'stories', 'your_activity']);

  // The Likes page (Your activity) is built with Bloks: tiles are plain buttons
  // with no link. The media id is only present in the thumbnail's cache key.
  const LIKE_TILE_SELECTOR = 'div[role="button"][aria-label] img[src*="ig_cache_key"]';
  const LIKE_VIDEO_RE = /^Video\b/; // aria-label starts "Video", "Photo" or "Carousel" (English UI)
  const SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const IG_EPOCH_MS = 1314220021721n; // media ids are snowflakes counted from this moment

  // Each source has its own tab. collect() returns the shortcodes visible right now.
  // scroller() returns the element Auto-scroll should drive (leave it out for no Auto-scroll).
  // timed marks a source whose log time is the watch time, so its rows show it.
  // Pages that match no source are not logged.
  const SOURCES = [
    { id: 'home', label: 'Home', test: (p) => p === '/', collect: reelsInView, timed: true },
    { id: 'reels', label: 'Reels', test: (p) => /^\/reels(\/|$)/.test(p), collect: reelInAddressBar, timed: true },
    { id: 'saved', label: 'Saved', test: (p) => /^\/[^/]+\/saved(\/|$)/.test(p), collect: reelTiles, scroller: pageScroller },
    { id: 'likes', label: 'Likes', test: (p) => /^\/your_activity\/interactions\/likes(\/|$)/.test(p), collect: likedVideos, scroller: likesScroller },
    // byUser: rows carry the profile they were logged on and the tab is sectioned by it, not by day.
    { id: 'profiles', label: 'Profiles', test: (p) => !!profileOf(p), collect: profileReels, scroller: pageScroller, byUser: true },
  ];

  const STORE_PREFIX = 'igHistory.v2.'; // one key per source, value is [[shortcode, unixSeconds], ...]
  const LEGACY_KEY = 'igHistory.v1';
  const SETTINGS_KEY = 'igHistory.settings'; // {prefix}
  const MIGRATED_KEY = 'igHistory.migrated'; // set once the page localStorage copy has been moved over
  const WRITER_KEY = 'igHistory.writer'; // {tab, n}, which tab made the last write
  const DAY_MS = 864e5;
  const FLASH_MS = 5000; // how long a newly logged link stays highlighted

  const logs = Object.fromEntries(SOURCES.map((s) => [s.id, new Map()])); // shortcode -> unix seconds first seen
  const sectionState = new Map(); // "source:label" -> open?
  const fresh = new Map(); // "source:shortcode" -> ms it was logged, for the highlight
  const owners = new Map(); // shortcode -> username, for byUser sources
  let profile = null; // username of the last profile Reels page, kept while a reel is open over it
  let live = null; // source being logged right now, null on pages that are not logged
  let view = null; // source tab shown in the panel
  let settingsOpen = false; // the Settings tab is shown instead of view
  let settings = { prefix: '' };
  let scrolling = false;
  let storageError = ''; // shown in the header while saving fails
  let ready = false; // nothing is logged or saved until the stored history has loaded

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nowSec = () => Math.floor(Date.now() / 1000);
  const urlOf = (code) => `https://www.instagram.com/reel/${code}/`;
  // What the Copy buttons put on the clipboard. The list itself always shows the plain link.
  const copyUrlOf = (code) => settings.prefix + urlOf(code);
  const codeRe = new RegExp(`^${ID}$`);

  // ---------- Storage ----------

  // History lives in chrome.storage.local, which survives clearing Instagram's
  // site data. Older versions kept it in the page's localStorage; that copy is
  // merged in once and then removed.

  // byUser entries have a third element, the username.
  function parse(data, users) {
    const out = new Map();
    if (!Array.isArray(data)) return out;
    for (const e of data) {
      if (!Array.isArray(e) || typeof e[0] !== 'string' || !codeRe.test(e[0]) || !Number.isFinite(e[1])) continue;
      out.set(e[0], e[1]);
      if (users && typeof e[2] === 'string' && e[2]) users.set(e[0], e[2]);
    }
    return out;
  }

  function entriesOf(id) {
    const byUser = SOURCES.find((s) => s.id === id).byUser;
    return [...logs[id]].map(([code, ts]) => (byUser ? [code, ts, owners.get(code) || ''] : [code, ts]));
  }

  // Adds entries that are not logged yet and keeps the log in time order. Returns how many were new.
  function merge(id, incoming, users) {
    let added = 0;
    for (const [code, ts] of incoming) {
      if (!logs[id].has(code)) {
        logs[id].set(code, ts);
        added++;
      }
      if (users.has(code) && !owners.has(code)) owners.set(code, users.get(code));
    }
    if (added) logs[id] = new Map([...logs[id]].sort((a, b) => a[1] - b[1]));
    return added;
  }

  // chrome.storage.onChanged also fires in the tab that wrote. Each write is
  // tagged so a tab can skip its own echo, which may be older than what it
  // has logged since.
  const tabToken = Math.random().toString(36).slice(2);
  let writeCount = 0;

  function write(items) {
    try {
      return chrome.storage.local.set({ ...items, [WRITER_KEY]: { tab: tabToken, n: ++writeCount } })
        .then(() => { storageError = ''; }, () => { storageError = 'Could not save, new entries are not being kept'; render(); });
    } catch {
      // chrome.* goes away in tabs left open while the extension is reloaded.
      storageError = 'Extension was reloaded. Refresh this tab.';
      return Promise.resolve();
    }
  }

  const save = (id) => write({ [STORE_PREFIX + id]: entriesOf(id) });
  const saveSettings = () => write({ [SETTINGS_KEY]: settings });

  function readSettings(data) {
    if (data && typeof data.prefix === 'string') settings.prefix = data.prefix;
  }

  async function load() {
    const keys = [...SOURCES.map((s) => STORE_PREFIX + s.id), SETTINGS_KEY, MIGRATED_KEY];
    const stored = await chrome.storage.local.get(keys);
    for (const s of SOURCES) logs[s.id] = parse(stored[STORE_PREFIX + s.id], owners);
    readSettings(stored[SETTINGS_KEY]);
    if (!stored[MIGRATED_KEY]) await migrate();
  }

  async function migrate() {
    const pageKeys = [...SOURCES.map((s) => STORE_PREFIX + s.id), SETTINGS_KEY, LEGACY_KEY];
    const read = (key) => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
    for (const s of SOURCES) {
      const users = new Map();
      merge(s.id, parse(read(STORE_PREFIX + s.id), users), users);
    }
    // v0.2 stored bare shortcodes with no time. Bring them in as logged now.
    const legacy = read(LEGACY_KEY);
    for (const s of SOURCES) {
      const codes = legacy && Array.isArray(legacy[s.id]) ? legacy[s.id] : [];
      merge(s.id, new Map(codes.filter((c) => typeof c === 'string' && codeRe.test(c)).map((c) => [c, nowSec()])), new Map());
    }
    if (!settings.prefix) readSettings(read(SETTINGS_KEY));
    const items = { [SETTINGS_KEY]: settings, [MIGRATED_KEY]: true };
    for (const s of SOURCES) items[STORE_PREFIX + s.id] = entriesOf(s.id);
    await chrome.storage.local.set(items);
    // Only once the copy is safely written. Leaving it would bring cleared links back on a reinstall.
    try { for (const key of pageKeys) localStorage.removeItem(key); } catch { /* storage blocked */ }
  }

  // Another Instagram tab wrote to the history. Take its copy so the tabs stay in step.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !ready) return;
    // Other parts of the extension (the download problem list) share this storage.
    if (!Object.keys(changes).some((key) => key === SETTINGS_KEY || key.startsWith(STORE_PREFIX))) return;
    const writer = changes[WRITER_KEY] && changes[WRITER_KEY].newValue;
    if (writer && writer.tab === tabToken) return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key === SETTINGS_KEY) {
        readSettings(newValue);
        if (prefixInput !== root.activeElement) prefixInput.value = settings.prefix;
        continue;
      }
      const id = key.startsWith(STORE_PREFIX) && key.slice(STORE_PREFIX.length);
      if (id && logs[id]) logs[id] = parse(newValue, owners);
    }
    render();
  });

  // ---------- Backup ----------

  function exportHistory() {
    const data = {
      app: 'insta-tools',
      format: 1,
      exported: new Date().toISOString(),
      settings,
      history: Object.fromEntries(SOURCES.map((s) => [s.id, entriesOf(s.id)])),
    };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const day = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
    const a = el('a', { href: URL.createObjectURL(blob), download: `insta-tools-history-${day}.json` });
    root.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    const total = SOURCES.reduce((n, s) => n + logs[s.id].size, 0);
    backupNote.textContent = `Exported ${total} links.`;
  }

  // Merges a backup into the current history. Nothing already logged is removed or changed.
  async function importHistory(file) {
    if (!ready) {
      backupNote.textContent = 'The saved history has not loaded, so nothing was imported.';
      return;
    }
    let data;
    try { data = JSON.parse(await file.text()); } catch { data = null; }
    if (!data || data.app !== 'insta-tools' || typeof data.history !== 'object' || !data.history) {
      backupNote.textContent = 'That file is not an Insta Tools backup.';
      return;
    }
    let added = 0;
    const items = {};
    for (const s of SOURCES) {
      const users = new Map();
      const n = merge(s.id, parse(data.history[s.id], users), users);
      if (n) items[STORE_PREFIX + s.id] = entriesOf(s.id);
      added += n;
    }
    if (!settings.prefix && data.settings && typeof data.settings.prefix === 'string' && data.settings.prefix) {
      readSettings(data.settings);
      items[SETTINGS_KEY] = settings;
    }
    await write(items);
    backupNote.textContent = added ? `Imported ${added} new links.` : 'Nothing new, every link in that file is already logged.';
    render();
  }

  // ---------- Detection ----------

  function isReel(a, type) {
    if (type !== 'p') return true;
    if (a.querySelector(`svg[aria-label="${CLIP_LABEL}"]`)) return true;
    for (const p of a.querySelectorAll('svg path')) {
      if ((p.getAttribute('d') || '').startsWith(CLIP_PATH_PREFIX)) return true;
    }
    return false;
  }

  function reelTiles() {
    const codes = [];
    for (const a of document.querySelectorAll(LINK_SELECTOR)) {
      const m = LINK_RE.exec(a.pathname);
      if (m && isReel(a, m[1])) codes.push(m[2]);
    }
    return codes;
  }

  function profileOf(path) {
    const m = PROFILE_REELS_RE.exec(path);
    return m && !NOT_PROFILES.has(m[1]) ? m[1] : null;
  }

  function profileReels() {
    const codes = [];
    for (const a of document.querySelectorAll(LINK_SELECTOR)) {
      const m = /^\/([^/]+)\/reel\/([A-Za-z0-9_-]+)\/?$/.exec(a.pathname);
      if (m && m[1] === profile) codes.push(m[2]);
    }
    return codes;
  }

  // Home feed: every post is an <article> and the reels among them carry a
  // /reels/ID/ link. Posts are preloaded well below the fold, so only the one
  // crossing the middle of the screen counts as seen.
  function reelsInView() {
    const middle = window.innerHeight / 2;
    const codes = [];
    for (const article of document.querySelectorAll('article')) {
      const box = article.getBoundingClientRect();
      if (box.top > middle || box.bottom < middle) continue;
      for (const a of article.querySelectorAll('a[href*="/reels/"]')) {
        const m = REELS_FEED_RE.exec(a.pathname);
        if (m) { codes.push(m[1]); break; }
      }
    }
    return codes;
  }

  function reelInAddressBar() {
    const m = REELS_FEED_RE.exec(location.pathname);
    return m ? [m[1]] : [];
  }

  const idDate = (id) => Number((id >> 23n) + IG_EPOCH_MS);

  function shortcodeOf(id) {
    let code = '';
    for (let n = id; n > 0n; n /= 64n) code = SHORTCODE_ALPHABET[Number(n % 64n)] + code;
    return code;
  }

  // The cache key is base64 of the media id, sometimes with a second id glued
  // on the end. Media ids are 19 digits now and were shorter before 2015, so
  // try each length and keep the one whose built-in date matches the tile's
  // "shared <date>" label. Without a readable label, take the first id that
  // is not dated in the future.
  function mediaIdOf(img, label) {
    let digits;
    try {
      digits = atob((new URL(img.src).searchParams.get('ig_cache_key') || '').split('.')[0]);
    } catch { return null; }
    if (!/^\d{15,}$/.test(digits)) return null;
    const shared = Date.parse((label.match(/shared (.+)$/) || [])[1]);
    let fallback = null;
    for (const length of digits.length <= 19 ? [digits.length] : [19, 18, 17]) {
      const id = BigInt(digits.slice(0, length));
      const date = idDate(id);
      if (date > Date.now() + DAY_MS) continue;
      if (Math.abs(date - shared) < 2 * DAY_MS) return id;
      fallback = fallback ?? id;
    }
    return fallback;
  }

  const likeCache = new Map(); // thumbnail src -> shortcode, or null for photos and carousels
  function likedVideos() {
    const codes = [];
    for (const img of document.querySelectorAll(LIKE_TILE_SELECTOR)) {
      if (!likeCache.has(img.src)) {
        const label = img.closest('[role="button"]').getAttribute('aria-label') || '';
        const id = LIKE_VIDEO_RE.test(label) ? mediaIdOf(img, label) : null;
        likeCache.set(img.src, id ? shortcodeOf(id) : null);
      }
      const code = likeCache.get(img.src);
      if (code) codes.push(code);
    }
    return codes;
  }

  function pageScroller() {
    return document.scrollingElement || document.documentElement;
  }

  // The Likes grid scrolls inside its own container, not the page.
  function likesScroller() {
    for (let node = document.querySelector(LIKE_TILE_SELECTOR); node && node !== document.body; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
    }
    return pageScroller();
  }

  function resolveSource() {
    const path = location.pathname;
    if (MODAL_RE.test(path)) return live;
    return SOURCES.find((s) => s.test(path));
  }

  function tick() {
    if (!host.isConnected) document.documentElement.appendChild(host);
    let changed = false;
    const source = resolveSource();
    const onProfile = profileOf(location.pathname);
    if (onProfile && onProfile !== profile) {
      profile = onProfile;
      changed = true; // reorder the Profiles tab so this profile is on top
    }
    if (source !== live || view === null) {
      live = source;
      // Follow the page to its tab. On a page that is not logged, stay on the last tab.
      view = source ? source.id : view || SOURCES[0].id;
      changed = true;
    }
    if (live && ready) {
      const log = logs[live.id];
      const before = log.size;
      for (const code of live.collect()) {
        if (log.has(code)) continue;
        log.set(code, nowSec());
        if (live.byUser) owners.set(code, profile);
        fresh.set(`${live.id}:${code}`, Date.now());
      }
      if (log.size !== before) {
        save(live.id);
        changed = true;
      }
    }
    if (changed) render();
  }

  // ---------- Grouping ----------

  const startOfDay = (ms) => new Date(ms).setHours(0, 0, 0, 0);

  function labelFor(age, dayMs) {
    if (age <= 0) return 'Today';
    if (age === 1) return 'Yesterday';
    if (age < 7) return new Date(dayMs).toLocaleDateString(undefined, { weekday: 'long' });
    if (age < 14) return 'Last week';
    if (age < 28) return `${Math.floor(age / 7)} weeks ago`;
    return new Date(dayMs).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  // One section per profile. The profile open right now goes on top, then the
  // rest by when they were last logged from. Newest first inside each.
  function groupsByUser(source) {
    const byUser = new Map();
    [...logs[source.id]].forEach(([code, ts], idx) => {
      const user = owners.get(code) || '';
      if (!byUser.has(user)) byUser.set(user, { label: user ? `@${user}` : 'Unknown', items: [], latest: 0, current: false });
      const group = byUser.get(user);
      group.items.push({ code, ts, idx });
      group.latest = Math.max(group.latest, idx);
      group.current = live === source && user === profile;
    });
    const groups = [...byUser.values()];
    for (const g of groups) g.items.reverse();
    return groups.sort((a, b) => b.current - a.current || b.latest - a.latest);
  }

  // Newest first on every tab: latest day on top, and within a day the most
  // recently logged link on top.
  function groupsFor(source) {
    if (source.byUser) return groupsByUser(source);
    const today = startOfDay(Date.now());
    const items = [...logs[source.id]].map(([code, ts], idx) => {
      const day = startOfDay(ts * 1000);
      return { code, ts, idx, day, age: Math.round((today - day) / DAY_MS) };
    });
    items.sort((a, b) => b.day - a.day || b.idx - a.idx);
    const groups = [];
    for (const item of items) {
      const label = labelFor(item.age, item.day);
      let group = groups[groups.length - 1];
      if (!group || group.label !== label) groups.push(group = { label, items: [], multiDay: item.age >= 7 });
      group.items.push(item);
    }
    return groups;
  }

  function timeText(ts, withDate) {
    const d = new Date(ts * 1000);
    const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return withDate ? `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}` : time;
  }

  // ---------- UI ----------

  const el = (tag, props = {}, children = []) => {
    const node = Object.assign(document.createElement(tag), props);
    children.forEach((c) => node.append(c));
    return node;
  };

  const host = el('div', { id: 'ig-history' });
  host.style.cssText = 'position:fixed;right:20px;bottom:84px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });

  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host { all: initial; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --bg: #fff; --fg: #111; --muted: #666; --line: #dbdbdb; --field: #fafafa; --accent: #0095f6; --flash: #ffe45c; }
    @media (prefers-color-scheme: dark) {
      :host { --bg: #1c1c1e; --fg: #f5f5f5; --muted: #a0a0a0; --line: #363636; --field: #121212; --flash: rgba(255, 214, 10, .34); }
    }
    * { box-sizing: border-box; font: inherit; }
    [hidden] { display: none !important; }
    .wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; color: var(--fg); }
    button { cursor: pointer; border: 1px solid var(--line); background: var(--bg); color: var(--fg);
      border-radius: 8px; padding: 6px 10px; }
    button:hover { border-color: var(--muted); }
    .fab { display: flex; align-items: center; gap: 8px; border-radius: 999px; padding: 8px 14px;
      font-weight: 600; box-shadow: 0 2px 10px rgba(0,0,0,.2); }
    .badge { background: var(--accent); color: #fff; border-radius: 999px; padding: 0 7px; min-width: 20px; text-align: center; }
    .panel { width: 480px; max-width: calc(100vw - 40px); background: var(--bg); border: 1px solid var(--line);
      border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.25); padding: 12px; display: flex; flex-direction: column; gap: 8px; }
    .head { display: flex; justify-content: space-between; align-items: baseline; }
    .title { font-weight: 600; font-size: 14px; }
    .status { color: var(--muted); font-size: 12px; }
    .tabs { display: flex; gap: 16px; border-bottom: 1px solid var(--line); }
    .tab { display: flex; align-items: center; gap: 6px; border: 0; border-bottom: 2px solid transparent; border-radius: 0;
      background: none; color: var(--muted); padding: 6px 0; margin-bottom: -1px; }
    .tab.active { color: var(--fg); border-bottom-color: var(--fg); font-weight: 600; }
    .count { color: var(--muted); font-weight: 400; font-variant-numeric: tabular-nums; }
    .list { height: 320px; max-height: 50vh; overflow-y: auto; background: var(--field);
      border: 1px solid var(--line); border-radius: 8px; }
    .empty { padding: 12px; color: var(--muted); }
    summary { position: sticky; top: 0; display: flex; align-items: center; gap: 8px; padding: 6px 8px;
      background: var(--bg); border-bottom: 1px solid var(--line); cursor: pointer; list-style: none; user-select: none; }
    summary::-webkit-details-marker { display: none; }
    summary::before { content: ""; border: 4px solid transparent; border-left-color: var(--muted); margin-right: -4px; transition: transform .1s; }
    details[open] > summary::before { transform: rotate(90deg) translate(2px, 2px); }
    .label { font-weight: 600; }
    .mini { margin-left: auto; padding: 1px 8px; font-size: 12px; border-radius: 6px; }
    .rows { padding: 4px 0; }
    .item { display: flex; align-items: baseline; gap: 8px; padding: 2px 8px;
      font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .item a { color: inherit; text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .item a:hover { text-decoration: underline; }
    .item.fresh { animation: flash ${FLASH_MS}ms ease-out both; }
    @keyframes flash { 0%, 50% { background: var(--flash); } 100% { background: transparent; } }
    .time { margin-left: auto; color: var(--muted); white-space: nowrap; user-select: none; }
    .row { display: flex; gap: 6px; }
    .row button { flex: 1; }
    .tab.settings { margin-left: auto; }
    .settings-pane { height: 320px; max-height: 50vh; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 6px;
      background: var(--field); border: 1px solid var(--line); border-radius: 8px; }
    .settings-pane label { font-weight: 600; }
    .settings-pane input { width: 100%; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px;
      background: var(--bg); color: var(--fg); font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .settings-pane .gap { margin-top: 10px; }
    .hint { color: var(--muted); font-size: 12px; }
    .example { color: var(--muted); font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; word-break: break-all; }
    .primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  `);
  root.adoptedStyleSheets = [sheet];

  const badge = el('span', { className: 'badge', textContent: '0' });
  const fab = el('button', { className: 'fab', title: 'Instagram History' }, ['History', badge]);
  const status = el('span', { className: 'status' });
  const list = el('div', { className: 'list' });
  const copyBtn = el('button', { className: 'primary', textContent: 'Copy all' });
  const scrollBtn = el('button', { textContent: 'Auto-scroll' });
  const clearBtn = el('button', { textContent: 'Clear' });

  const actions = el('div', { className: 'row' }, [copyBtn, scrollBtn, clearBtn]);

  const tabs = new Map();
  for (const s of SOURCES) {
    const btn = el('button', { className: 'tab', textContent: s.label });
    btn.addEventListener('click', () => { view = s.id; settingsOpen = false; disarmClear(); render(); });
    tabs.set(s.id, { btn });
  }
  const settingsTab = el('button', { className: 'tab settings', textContent: 'Settings' });
  settingsTab.addEventListener('click', () => { settingsOpen = true; disarmClear(); render(); });

  // Built once and only shown or hidden, so the field keeps focus while links are being logged.
  const prefixInput = el('input', { type: 'text', id: 'prefix', spellcheck: false, placeholder: 'Nothing' });
  const prefixExample = el('div', { className: 'example' });
  const showExample = () => { prefixExample.textContent = `Copies as: ${copyUrlOf('SHORTCODE')}`; };
  prefixInput.addEventListener('input', () => {
    settings.prefix = prefixInput.value;
    saveSettings();
    showExample();
  });
  const exportBtn = el('button', { textContent: 'Export' });
  const importBtn = el('button', { textContent: 'Import' });
  const fileInput = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
  const backupNote = el('div', { className: 'hint' });
  exportBtn.addEventListener('click', exportHistory);
  importBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) importHistory(fileInput.files[0]);
    fileInput.value = ''; // so the same file can be picked again
  });
  const settingsPane = el('div', { className: 'settings-pane', hidden: true }, [
    el('label', { htmlFor: 'prefix', textContent: 'Copy prefix' }),
    prefixInput,
    el('div', { className: 'hint', textContent: 'Added to the start of every link when copying. Include a trailing space if you want one.' }),
    prefixExample,
    el('label', { className: 'gap', textContent: 'Backup' }),
    el('div', { className: 'row' }, [exportBtn, importBtn]),
    el('div', { className: 'hint', textContent: 'Export saves every tab to a file. Import merges a file back in and never removes anything. History is kept by the extension, so removing the extension deletes it. Export first.' }),
    backupNote,
    fileInput,
  ]);

  const panel = el('div', { className: 'panel', hidden: true }, [
    el('div', { className: 'head' }, [el('span', { className: 'title', textContent: 'Instagram History' }), status]),
    el('div', { className: 'tabs' }, [...[...tabs.values()].map((t) => t.btn), settingsTab]),
    list,
    settingsPane,
    actions,
  ]);
  root.append(el('div', { className: 'wrap' }, [panel, fab]));

  function itemRow(item, group, source) {
    const url = urlOf(item.code);
    const copyUrl = copyUrlOf(item.code);
    const link = el('a', { href: url, target: '_blank', rel: 'noopener', textContent: url, title: 'Click to copy, middle click to open' });
    // Only the feeds have a meaningful time. On grid pages it is just when the tile was first seen.
    const note = el('span', { className: 'time', textContent: source.timed ? timeText(item.ts, group.multiDay) : '' });
    // A plain click copies this one link. Middle click and ctrl/cmd click still open it.
    link.addEventListener('click', (e) => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      copyText(copyUrl, note, 'Copied');
    });
    const row = el('div', { className: 'item' }, [link, note]);
    const born = fresh.get(`${source.id}:${item.code}`);
    if (born && Date.now() - born < FLASH_MS) {
      row.classList.add('fresh');
      // The list is rebuilt on every change. A negative delay resumes the fade instead of restarting it.
      row.style.animationDelay = `${born - Date.now()}ms`;
    }
    return row;
  }

  function renderList() {
    const source = SOURCES.find((s) => s.id === view);
    const groups = groupsFor(source);
    const top = list.scrollTop;
    for (const [key, born] of fresh) if (Date.now() - born >= FLASH_MS) fresh.delete(key);
    list.replaceChildren();
    if (!groups.length) {
      list.append(el('div', { className: 'empty', textContent: 'Nothing logged from this source yet.' }));
      return;
    }
    groups.forEach((group, i) => {
      const key = `${view}:${group.label}`;
      const rows = el('div', { className: 'rows' });
      const copyOne = el('button', { className: 'mini', textContent: 'Copy' });
      const details = el('details', {}, [
        el('summary', {}, [
          el('span', { className: 'label', textContent: group.label }),
          el('span', { className: 'count', textContent: String(group.items.length) }),
          copyOne,
        ]),
        rows,
      ]);
      // Rows are only built for open sections, so a long history stays cheap to show.
      const fill = () => {
        if (!rows.childElementCount) rows.append(...group.items.map((item) => itemRow(item, group, source)));
      };
      details.open = sectionState.has(key) ? sectionState.get(key) : i === 0;
      if (details.open) fill();
      details.addEventListener('toggle', () => {
        sectionState.set(key, details.open);
        if (details.open) fill();
      });
      copyOne.addEventListener('click', (e) => {
        e.preventDefault(); // do not toggle the section
        copyText(group.items.map((item) => copyUrlOf(item.code)).join('\n'), copyOne, `Copied ${group.items.length}`);
      });
      list.append(details);
    });
    list.scrollTop = top;
  }

  function render() {
    for (const s of SOURCES) {
      const t = tabs.get(s.id);
      t.btn.classList.toggle('active', !settingsOpen && s.id === view);
    }
    // Total across every tab, now that the tabs no longer show their own counts.
    const total = SOURCES.reduce((n, s) => n + logs[s.id].size, 0);
    badge.textContent = String(total);
    fab.title = `Instagram History: ${SOURCES.map((s) => `${s.label} ${logs[s.id].size}`).join(', ')}`;
    status.textContent = storageError || (!ready ? 'Loading' : live ? `Logging: ${live.label}` : 'Not logging on this page');
    // Auto-scroll only makes sense on a grid page, while looking at that page's tab.
    scrollBtn.hidden = !(live && live.scroller && view === live.id);
    settingsTab.classList.toggle('active', settingsOpen);
    list.hidden = settingsOpen;
    settingsPane.hidden = !settingsOpen;
    // Invisible rather than hidden, so the panel keeps its height when switching to Settings.
    actions.style.visibility = settingsOpen ? 'hidden' : '';
    if (settingsOpen) {
      if (prefixInput !== root.activeElement) prefixInput.value = settings.prefix;
      showExample();
    } else if (!panel.hidden) {
      renderList();
    }
  }

  function flash(btn, text) {
    if (btn.dataset.label === undefined) btn.dataset.label = btn.textContent;
    btn.textContent = text;
    clearTimeout(btn._flash);
    btn._flash = setTimeout(() => { btn.textContent = btn.dataset.label; }, 1500);
  }

  async function copyText(text, btn, done) {
    if (!text) return flash(btn, 'Nothing to copy');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = el('textarea', { value: text });
      root.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    flash(btn, done);
  }

  function copyAll() {
    const source = SOURCES.find((s) => s.id === view);
    const urls = groupsFor(source).flatMap((g) => g.items.map((item) => copyUrlOf(item.code)));
    copyText(urls.join('\n'), copyBtn, `Copied ${urls.length}`);
  }

  // Scrolls to the bottom until nothing new loads for a few rounds.
  async function autoScroll() {
    if (scrolling) { scrolling = false; return; }
    if (!live || !live.scroller) return;
    scrolling = true;
    scrollBtn.textContent = 'Stop';
    const source = live;
    let idle = 0;
    let lastHeight = 0;
    let lastCount = logs[source.id].size;
    while (scrolling && idle < 6 && live === source) {
      const target = source.scroller();
      target.scrollTop = target.scrollHeight;
      await sleep(1200);
      tick();
      const height = target.scrollHeight;
      const count = logs[source.id].size;
      idle = height === lastHeight && count === lastCount ? idle + 1 : 0;
      lastHeight = height;
      lastCount = count;
    }
    scrolling = false;
    scrollBtn.textContent = 'Auto-scroll';
  }

  // History is never cleared automatically. Clearing by hand takes two clicks.
  let clearTimer = 0;
  function disarmClear() {
    clearTimeout(clearTimer);
    clearTimer = 0;
    clearBtn.textContent = 'Clear';
  }
  function clear() {
    if (!ready) return;
    if (!clearTimer) {
      clearBtn.textContent = `Delete ${logs[view].size} from ${SOURCES.find((s) => s.id === view).label}?`;
      clearTimer = setTimeout(disarmClear, 3000);
      return;
    }
    disarmClear();
    if (SOURCES.find((s) => s.id === view).byUser) for (const code of logs[view].keys()) owners.delete(code);
    logs[view] = new Map();
    save(view);
    render();
  }

  fab.addEventListener('click', () => { panel.hidden = !panel.hidden; render(); });
  copyBtn.addEventListener('click', copyAll);
  scrollBtn.addEventListener('click', autoScroll);
  clearBtn.addEventListener('click', clear);
  // Keep Instagram's keyboard shortcuts from firing while the panel has focus.
  host.addEventListener('keydown', (e) => e.stopPropagation());

  // ---------- Start ----------

  document.documentElement.appendChild(host);
  load()
    .catch(() => { storageError = 'Could not read the saved history'; })
    .finally(() => {
      // If loading failed, log nothing: a save now would overwrite the history that could not be read.
      ready = !storageError;
      tick();
      render();
      // Polling covers both new tiles and address bar changes, which fire no event.
      setInterval(tick, 400);
    });
})();
