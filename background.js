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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || msg.type !== 'helper') return undefined;
  const payload = msg.payload || {};
  let request = null;

  if (payload.action === 'ping') {
    request = { action: 'ping' };
  } else if (payload.action === 'download') {
    // Downloads are only accepted from an Instagram tab, and only as a post
    // shortcode plus a plain file name. The helper builds the address itself.
    const fromInstagram = sender.tab && /^https:\/\/www\.instagram\.com\//.test(sender.tab.url || '');
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
