// Asks the helper for its status and shows what is and is not set up.

const $ = (id) => document.getElementById(id);

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
      show('bad', 'Helper not connected. Videos are saved from the page instead (usually 720p).');
      hint(`Run native/install.sh from the extension folder, then check again. Extension ID: ${chrome.runtime.id}. Chrome said: ${reason}`);
      return;
    }
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

$('retry').addEventListener('click', check);
check();
