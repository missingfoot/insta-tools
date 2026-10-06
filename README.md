# Insta Tools

A Chrome extension that adds two tools to instagram.com:

- History: a floating panel that logs the reels you come across, split by where you saw them and grouped by day, as copyable links.
- Download: a button in the top right corner of post images, gallery images, videos and reels.

Videos and reels are saved at full quality by a small helper on your computer that runs yt-dlp. Without the helper everything still works, but videos are saved as the single MP4 the page already has, which is usually 720p.

Nothing is sent anywhere. History is kept in the browser, and downloads go from Instagram straight to your disk.

## Requirements

- Chrome 111 or newer (or another Chromium browser: Chromium, Brave, Edge, Vivaldi).
- Linux or macOS for the helper. The extension itself works on any system.
- For full quality video: Python 3, [yt-dlp](https://github.com/yt-dlp/yt-dlp) and ffmpeg.
- Instagram set to English for the Likes tab of History.

## Install the extension

1. Put this folder somewhere permanent. Chrome loads it from where it sits, and the helper is registered by its path.
2. Open `chrome://extensions` and turn on Developer mode (top right).
3. Click "Load unpacked" and choose this folder.
4. Reload any open Instagram tabs.

The extension ID is pinned by the `key` in `manifest.json`, so it is always `aiiebmkfkohfbicheaecifejllipofdd`. The helper is registered for that ID.

If you used the earlier Tampermonkey scripts (Instagram History, Instagram Image Download), disable them. They do the same job and whichever loads first wins, so with them enabled you may not get the yt-dlp path. Your logged history carries over, because it is stored by the page and not by the script.

## Install the video helper

Chrome does not let an extension run programs. The supported way round that is a native messaging host: a small program you register with the browser, which the extension can then start. Here that program is `native/insta_tools_host.py`.

1. Install yt-dlp and ffmpeg with your package manager, for example `sudo pacman -S yt-dlp ffmpeg`, `sudo apt install yt-dlp ffmpeg` or `brew install yt-dlp ffmpeg`.
2. Register the helper:

   ```sh
   ./native/install.sh
   ```

3. Click the Insta Tools icon in the toolbar. The popup should say "Helper connected" and show the yt-dlp version, the ffmpeg path and the save folder.

Run `install.sh` again if you move the folder. `native/uninstall.sh` removes the registration.

The script writes one small JSON file per browser it finds, for example `~/.config/google-chrome/NativeMessagingHosts/com.jamessparkes.insta_tools.json`. Chrome installed as a Flatpak or Snap keeps its profile elsewhere and is not covered.

### Settings

Optional. Create `~/.config/insta-tools/config.json` with any of these keys:

```json
{
  "download_dir": "~/Downloads/Insta Tools",
  "cookies_from_browser": "chrome",
  "yt_dlp": "",
  "ffmpeg": "",
  "timeout_seconds": 600
}
```

| Key | Meaning |
| --- | --- |
| `download_dir` | Where videos saved by the helper go. |
| `cookies_from_browser` | Browser whose Instagram login yt-dlp may borrow (its `--cookies-from-browser` option). Set to `""` to never use a login. |
| `yt_dlp`, `ffmpeg` | Full paths, only needed if the popup says they were not found. |
| `timeout_seconds` | How long one yt-dlp run may take. |

About the login: each download is first tried without one. Only if that fails does the helper retry with your browser's Instagram session. Instagram often refuses anonymous requests, so expect the retry to be the one that works. That retry makes requests as your account from outside the browser, which Instagram can rate limit. Set `cookies_from_browser` to `""` if you would rather not, and failed videos fall back to the page's 720p file.

## Using it

### Download buttons

A round button sits in the top right of each post image and video. On feed reels where Instagram has its own "More options" dots in that corner, the button sits just below them.

| What | How it is saved | Where |
| --- | --- | --- |
| Image, gallery image | Full size file from the page | Browser downloads folder |
| Video or reel | yt-dlp via the helper, best video and audio merged to MP4 | `download_dir` |
| Video or reel, helper missing or failed | The page's own MP4, usually 720p | Browser downloads folder |
| Video slide inside a gallery | The page's own MP4, usually 720p | Browser downloads folder |

The button colour tells you what happened. Hover it for the detail.

- Green: saved. For a video this means full quality through yt-dlp.
- Amber: saved, but only the page's MP4. The tooltip says why the helper was not used.
- Red: nothing was saved.

File names are `username_shortcode.ext`, with `_2`, `_3` and so on for gallery slides.

Gallery video slides skip yt-dlp because yt-dlp downloads a whole post, not one slide.

### History

A "History" button at the bottom right of instagram.com opens the panel.

| Tab | Page | What gets logged |
| --- | --- | --- |
| Home | `instagram.com/` | Each reel that crosses the middle of the screen as you scroll the feed. |
| Reels | `instagram.com/reels/...` | Each reel that snaps into view. |
| Saved | `instagram.com/<you>/saved/...` | Every reel tile that loads in the saved grid. |
| Likes | Your activity > Interactions > Likes | Every video tile that loads in the likes grid. |
| Profiles | A profile's Reels tab, such as instagram.com/username/reels/ | Every reel tile that loads in that profile's grid. Sectioned by username instead of by day, with the profile you are on at the top. |

- Links are grouped by day (Today, Yesterday, weekday names, Last week, then older), newest first. A newly logged link is highlighted yellow for a few seconds.
- Click a link to copy it. Middle click or ctrl/cmd click opens it.
- Each day (or each profile on the Profiles tab) has a Copy button, and "Copy all" copies the whole tab.
- Auto-scroll (Saved, Likes and Profiles) keeps scrolling so the whole grid loads. Keep the tab in the foreground.
- Settings (the last tab) has a copy prefix: text added to the start of every link when you press Copy, Copy all or click a link. The list still shows plain links. Include a trailing space if you want one.
- Settings also has Export (saves every tab to a JSON file) and Import (merges a backup in, never removes anything).
- Clear deletes the tab you are viewing and needs a second click to confirm. Nothing is cleared automatically.

History is stored in the extension's own storage (`chrome.storage.local`, with no size limit) under `igHistory.v2.home`, `.reels`, `.saved`, `.likes` and `.profiles`, as `[shortcode, unixSeconds]` pairs (Profiles adds the username as a third value). Clearing browsing or site data for instagram.com does not touch it. Removing the extension deletes it (reloading it does not), so use Settings > Export to keep a backup. History saved by earlier versions in instagram.com's localStorage is moved over automatically the first time the panel loads.

## How it works

```
instagram.com page
  content/history.js   (extension world) History panel, saves to chrome.storage
  content/download.js  (page world)      Download buttons
        | window message
  content/bridge.js    (extension world) relays to the extension
        | runtime message
  background.js        (service worker)  checks the request, opens the helper
        | native messaging (stdin/stdout)
  native/insta_tools_host.py             runs yt-dlp, replies with the file path
```

The two tools run in the page's own JavaScript world because the video address is read from Instagram's React objects, which only exist there. Extension APIs do not exist in that world, so `bridge.js` passes helper requests along.

The page can only ask for one thing: "download the post with this shortcode, under this file name". The background worker and the helper each check both values against a strict pattern. The helper builds the Instagram address and the output path itself and never runs a shell, so a page cannot make it fetch other sites or write outside the download folder. Only this extension's ID is allowed to start the helper.

## Limitations

- Everything here reads Instagram's page structure, which changes without notice. If a tool stops working on one kind of page, that page's markup has probably changed.
- yt-dlp's Instagram support breaks from time to time when Instagram changes things. Updating yt-dlp usually fixes it. Until then videos fall back to the page's MP4 and the button goes amber.
- The Likes tab needs the English UI.
- Desktop only.
- The helper install script covers Linux and macOS. On Windows the extension works, but the helper would need a registry entry that is not included.

## Troubleshooting

- Popup says "Helper not connected": run `native/install.sh` again and check the extension ID on `chrome://extensions` matches the one the script printed. If it differs, pass it in: `./native/install.sh <id>`.
- Popup says yt-dlp or ffmpeg was not found: Chrome can start the helper with a shorter PATH than your terminal. Put the full paths in the settings file.
- Video buttons go amber: hover the button to read yt-dlp's error. "Login required" means the login retry did not work, so check `cookies_from_browser` names the browser you are logged in with.
- No buttons or no History panel: check the extension is enabled, reload the tab, and make sure the old Tampermonkey scripts are disabled.
- After reloading the extension on `chrome://extensions`, refresh open Instagram tabs.

## Files

| Path | Purpose |
| --- | --- |
| `manifest.json` | Extension manifest (Manifest V3). |
| `background.js` | Service worker that talks to the helper. |
| `content/history.js` | History panel. |
| `content/download.js` | Download buttons. |
| `content/bridge.js` | Relay between the page and the extension. |
| `popup.html`, `popup.js`, `popup.css` | Toolbar popup showing helper status. |
| `icons/` | Extension icons. |
| `native/insta_tools_host.py` | The helper. |
| `native/install.sh`, `native/uninstall.sh` | Register and unregister the helper. |

## Licence

MIT. See `LICENSE`.
