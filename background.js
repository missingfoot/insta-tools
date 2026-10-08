// Service worker. Its only job is to talk to the local helper (a native
// messaging host) on behalf of the page and the popup.

const HOST = 'com.jamessparkes.insta_tools';
const CODE_RE = /^[A-Za-z0-9_-]{5,20}$/;
const NAME_RE = /^[A-Za-z0-9_.-]{1,120}$/;

// One message in, one message out. An open native port also keeps this worker
// alive, so a long download is not cut short when the worker would normally sleep.
function callHelper(message) {
  return new Promise((resolve) => {
    let port;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
      try { port.disconnect(); } catch { /* already closed */ }
    };
    try {
      port = chrome.runtime.connectNative(HOST);
    } catch (err) {
      resolve({ ok: false, code: 'no-helper', error: String(err.message || err) });
      return;
    }
    port.onMessage.addListener(finish);
    port.onDisconnect.addListener(() => {
      const reason = chrome.runtime.lastError ? chrome.runtime.lastError.message : 'Helper exited without replying';
      finish({ ok: false, code: 'no-helper', error: reason });
    });
    port.postMessage(message);
  });
}

// Downloads that went amber or red, newest last, for the popup's problem list.
// Kept in the extension's storage because the helper's own log never sees
// failures that happen before it is reached (helper not found, page errors).
const PROBLEMS_KEY = 'insta-tools.problems';
const PROBLEMS_MAX = 50;
let problemWrites = Promise.resolve();

// The report comes from the page, so it is only ever stored and shown as text.
function recordProblem(report) {
  const text = (value, max) => String(value == null ? '' : value).slice(0, max);
  const entry = {
    time: Date.now(),
    state: report.state === 'error' ? 'error' : 'fallback',
    code: text(report.code, 20),
    page: text(report.page, 200),
    note: text(report.note, 600),
  };
  // One read-modify-write at a time, so two quick failures do not overwrite each other.
  problemWrites = problemWrites.then(async () => {
    const stored = (await chrome.storage.local.get(PROBLEMS_KEY))[PROBLEMS_KEY];
    const list = Array.isArray(stored) ? stored : [];
    list.push(entry);
    await chrome.storage.local.set({ [PROBLEMS_KEY]: list.slice(-PROBLEMS_MAX) });
  }).catch(() => { /* storage failed; nothing else to tell */ });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || msg.type !== 'helper') return undefined;
  const payload = msg.payload || {};
  const fromInstagram = sender.tab && /^https:\/\/www\.instagram\.com\//.test(sender.tab.url || '');
  // The log holds file paths and CDN addresses, so only the popup may read it,
  // never a page. Only this extension can serve its popup address.
  const fromPopup = sender.url === chrome.runtime.getURL('popup.html');
  let request = null;

  if (payload.action === 'report') {
    if (fromInstagram) recordProblem(payload);
    sendResponse({ ok: true });
    return undefined;
  }

  if (payload.action === 'ping') {
    request = { action: 'ping' };
  } else if (payload.action === 'log' && fromPopup) {
    request = { action: 'log' };
  } else if (payload.action === 'download') {
    // Downloads are only accepted from an Instagram tab, and only as a post
    // shortcode plus a plain file name. The helper builds the address itself.
    if (fromInstagram && CODE_RE.test(payload.code || '') && NAME_RE.test(payload.name || '')) {
      request = { action: 'download', code: payload.code, name: payload.name };
    }
  }

  if (!request) {
    sendResponse({ ok: false, error: 'Request rejected' });
    return undefined;
  }
  callHelper(request).then(sendResponse);
  return true; // answer comes later
});
