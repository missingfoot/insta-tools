// Runs in the extension's isolated world. The tools themselves run in the
// page's world (they need the page's own JavaScript objects), where extension
// APIs do not exist. This relays their helper requests to the background
// service worker and passes the answer back.
//
// Instagram's own scripts could post the same message, so nothing here is
// trusted: the background worker and the helper both validate every field.

(function () {
  'use strict';
  const CHANNEL = 'insta-tools';

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const msg = event.data;
    if (!msg || msg.channel !== CHANNEL || msg.type !== 'request' || typeof msg.id !== 'string') return;

    const reply = (type, result) => window.postMessage({ channel: CHANNEL, type, id: msg.id, result }, location.origin);
    reply('ack'); // tells the page a bridge exists, so it can wait for the real answer

    try {
      chrome.runtime.sendMessage({ type: 'helper', payload: msg.payload }, (result) => {
        const failed = chrome.runtime.lastError;
        reply('result', failed ? { ok: false, error: failed.message } : result);
      });
    } catch (err) {
      // Thrown when the extension was reloaded while this tab stayed open.
      reply('result', { ok: false, error: 'Extension was reloaded. Refresh this tab.' });
    }
  });
})();
