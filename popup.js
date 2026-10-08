// Asks the helper for its status and shows what is and is not set up, plus
// recent download problems and the helper's log, ready to copy as one report.

const $ = (id) => document.getElementById(id);
const PROBLEMS_KEY = 'insta-tools.problems'; // must match background.js
let lastPing = null; // the helper's status, or why it could not be reached

function show(kind, text) {
  $('status').className = `status ${kind}`;
  $('status').textContent = text;
}

function hint(text) {
  $('hint').hidden = !text;
  $('hint').textContent = text || '';
}

function check() {
  show('', 'Checking the helper...');
  $('details').hidden = true;
  hint('');
  chrome.runtime.sendMessage({ type: 'helper', payload: { action: 'ping' } }, (reply) => {
    if (chrome.runtime.lastError || !reply || !reply.ok) {
      const reason = chrome.runtime.lastError ? chrome.runtime.lastError.message : (reply && reply.error) || 'No reply';
      lastPing = { connected: false, reason };
      show('bad', 'Helper not connected. Videos are saved from the page instead (usually 720p).');
      hint(`Run native/install.sh from the extension folder, then check again. Extension ID: ${chrome.runtime.id}. Chrome said: ${reason}`);
      return;
    }
    lastPing = { connected: true, ...reply };
    $('details').hidden = false;
    $('ytdlp').textContent = reply.yt_dlp ? `${reply.yt_dlp_version || 'found'} (${reply.yt_dlp})` : 'Not found';
    $('ffmpeg').textContent = reply.ffmpeg || 'Not found';
    $('folder').textContent = reply.download_dir;
    $('cookies').textContent = reply.cookies_from_browser || 'Never (downloads are tried without a login only)';
    $('config').textContent = reply.config_path;

    if (reply.config_error) {
      show('warn', 'Helper connected, but the settings file could not be read. Defaults are in use.');
      hint(reply.config_error);
    } else if (!reply.yt_dlp) {
      show('warn', 'Helper connected, but yt-dlp was not found.');
      hint('Install yt-dlp, or set its full path as "yt_dlp" in the settings file.');
    } else if (!reply.ffmpeg) {
      show('warn', 'Helper connected, but ffmpeg was not found. Full quality video and audio cannot be merged without it.');
      hint('Install ffmpeg, or set its full path as "ffmpeg" in the settings file.');
    } else {
      show('ok', 'Helper connected. Videos and reels are saved at full quality with yt-dlp.');
    }
  });
}

// ---------- Problems and log ----------

const stamp = (ms) => {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

async function readProblems() {
  const stored = (await chrome.storage.local.get(PROBLEMS_KEY))[PROBLEMS_KEY];
  return (Array.isArray(stored) ? stored : []).slice().reverse();
}

async function renderProblems() {
  const problems = await readProblems();
  const list = $('problems');
  list.replaceChildren(...problems.map((p) => {
    const item = document.createElement('li');
    item.className = p.state === 'error' ? 'error' : 'fallback';
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${stamp(p.time)}  ${p.state === 'error' ? 'Not saved' : 'Saved at page quality'}${p.code ? `  ${p.code}` : ''}`;
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = p.note;
    item.append(meta, note);
    return item;
  }));
  list.hidden = !problems.length;
  $('problems-empty').hidden = problems.length > 0;
}

function readLog() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'helper', payload: { action: 'log' } }, (reply) => {
      if (chrome.runtime.lastError || !reply) resolve({ ok: false, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : 'No reply' });
      else resolve(reply);
    });
  });
}

async function showLog() {
  $('log').textContent = 'Loading...';
  const log = await readLog();
  $('logpath').textContent = log.path ? `Full log: ${log.path}` : '';
  $('log').textContent = log.ok ? (log.text || 'The log is empty.') : `Could not read the log: ${log.error}`;
  $('log').scrollTop = $('log').scrollHeight;
}

async function buildReport() {
  const lines = ['Insta Tools problem report', `Extension ${chrome.runtime.getManifest().version}, ${navigator.userAgent}`, ''];
  if (!lastPing) lines.push('Helper: not checked yet');
  else if (!lastPing.connected) lines.push(`Helper: not connected (${lastPing.reason})`);
  else {
    lines.push(`Helper: connected, yt-dlp ${lastPing.yt_dlp_version || 'unknown'} (${lastPing.yt_dlp || 'not found'}), ffmpeg ${lastPing.ffmpeg || 'not found'}`);
    lines.push(`Saves to ${lastPing.download_dir}, login from ${lastPing.cookies_from_browser || 'never'}`);
    if (lastPing.config_error) lines.push(`Settings problem: ${lastPing.config_error}`);
  }
  const problems = await readProblems();
  lines.push('', `Recent problems (${problems.length}, newest first):`);
  if (!problems.length) lines.push('none');
  for (const p of problems) lines.push(`${stamp(p.time)}  ${p.state}  ${p.code || '-'}  ${p.page || '-'}`, `  ${p.note}`);
  const log = await readLog();
  lines.push('', log.ok ? `Helper log (end of ${log.path}${log.truncated ? ', older lines left out' : ''}):` : `Helper log: could not read it (${log.error})`);
  if (log.ok) lines.push(log.text.trimEnd() || 'empty');
  return lines.join('\n');
}

$('copy').addEventListener('click', async () => {
  $('copied').textContent = 'Copying...';
  try {
    await navigator.clipboard.writeText(await buildReport());
    $('copied').textContent = 'Copied. Paste it into the chat.';
  } catch (err) {
    $('copied').textContent = `Could not copy: ${err.message}`;
  }
});

// The first click arms the button, a second within 3 seconds clears, as in the History panel.
let clearArmed = 0;
$('clear').addEventListener('click', async () => {
  if (Date.now() - clearArmed > 3000) {
    clearArmed = Date.now();
    $('clear').textContent = 'Click again to clear';
    setTimeout(() => { if (Date.now() - clearArmed >= 3000) $('clear').textContent = 'Clear'; }, 3000);
    return;
  }
  clearArmed = 0;
  $('clear').textContent = 'Clear';
  await chrome.storage.local.remove(PROBLEMS_KEY);
});

$('logbox').addEventListener('toggle', () => { if ($('logbox').open) showLog(); });
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes[PROBLEMS_KEY]) renderProblems(); });

$('retry').addEventListener('click', check);
check();
renderProblems();
