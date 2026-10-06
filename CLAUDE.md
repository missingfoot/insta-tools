# Insta Tools: project notes

Handover notes for continuing this project in Claude Code. They cover what exists, how each part works, what was learned about Instagram's pages along the way, what has and has not been tested, and what to do next.

User-facing setup and usage are in `README.md`. This file is the background a developer needs.

Tip: rename this file to `CLAUDE.md` in the repo root and Claude Code will load it automatically at the start of every session.

Last updated: 3 October 2026.

## Current state

- A Manifest V3 Chrome extension called Insta Tools, version 1.0.0.
- It merges two earlier Tampermonkey userscripts (Instagram History v0.7.0 and Instagram Image Download v0.2.0). Those userscripts are superseded and should be disabled when the extension is installed.
- Two tools run on instagram.com:
  - History: a floating panel that logs reel links per source (Home, Reels, Saved, Likes, Profiles), grouped by day.
  - Download: a button in the top right of post images, gallery images, videos and reels.
- A native messaging helper (`native/insta_tools_host.py`) runs yt-dlp so videos are saved at full quality. Without it, videos fall back to the page's own MP4 (about 720p).
- Git repo on GitHub at https://github.com/missingfoot/insta-tools (public). No licence file yet.

Environment it was built for: Google Chrome 153 on Linux x86 (CachyOS). The helper install script covers Linux and macOS.

## Layout

```
insta-tools/
  manifest.json                MV3 manifest, pins the extension ID with "key"
  background.js                service worker, talks to the helper
  content/history.js           History panel            (extension world)
  content/download.js          Download buttons         (page world)
  content/bridge.js            page <-> extension relay (extension world)
  popup.html / popup.js / popup.css   toolbar popup, shows helper status
  icons/                       icon16/48/128.png (original artwork, generated with PIL)
  native/insta_tools_host.py   native messaging host, runs yt-dlp
  native/install.sh            registers the host with Chromium browsers
  native/uninstall.sh          removes the registration
  README.md                    user documentation
  NOTES.md                     this file
```

Fixed identifiers:

| Thing | Value |
| --- | --- |
| Extension ID | `aiiebmkfkohfbicheaecifejllipofdd` |
| Native host name | `com.jamessparkes.insta_tools` |
| Page message channel | `insta-tools` |
| History storage keys | `igHistory.v2.home`, `.reels`, `.saved`, `.likes`, `.profiles`, settings in `igHistory.settings` |
| History DOM host | `#ig-history` (shadow root) |
| Download button class | `igdl-btn` |
| Load guards | `window.__igHistoryLoaded`, `window.__igImageDownloadLoaded` |
| Helper config | `~/.config/insta-tools/config.json` |

The extension ID comes from the public key in `manifest.json`. The private half was thrown away on purpose: it is only needed to pack a `.crx`. If this ever goes to the Chrome Web Store, remove `key` (the store assigns its own ID) and update the ID in `native/install.sh`.

## Architecture

```
instagram.com page
  content/history.js   (world: ISOLATED)  History panel, chrome.storage.local
  content/download.js  (world: MAIN)      Download buttons
        | window.postMessage, channel "insta-tools"
  content/bridge.js    (world: ISOLATED)  relays to the extension
        | chrome.runtime.sendMessage({type: "helper", payload})
  background.js        (service worker)   validates, opens the helper
        | chrome.runtime.connectNative (stdin/stdout, 4 byte length + JSON)
  native/insta_tools_host.py              runs yt-dlp, replies with the file path
```

Why the download tool runs in the MAIN world: it reads the video address from React fiber objects attached to DOM nodes (`__reactFiber$...`), which are only visible in the page's own JavaScript world. MAIN world scripts cannot use `chrome.*`, hence the bridge. History needs nothing from the page's JavaScript (only the DOM, the address bar and, for the one-time migration, the page's localStorage, which the isolated world shares), so it runs in the ISOLATED world and uses `chrome.storage` directly. Its load guard is therefore on the isolated `window` and does not see an old userscript copy.

Message flow for a video download:

1. `download.js` posts `{channel, type: "request", id, payload: {action: "download", code, name}}`.
2. `bridge.js` immediately posts `{type: "ack", id}`, then forwards to the background worker. If no ack arrives within 800 ms, `download.js` assumes there is no bridge and falls back.
3. `background.js` checks the sender is an instagram.com tab, `code` matches `^[A-Za-z0-9_-]{5,20}$` and `name` matches `^[A-Za-z0-9_.-]{1,120}$`, then opens a native port. An open native port keeps the MV3 service worker alive for the length of the download.
4. The host validates again, builds `https://www.instagram.com/reel/<code>/` itself, runs yt-dlp without a shell, and replies `{ok, file, size, used_login, merged}` or `{ok: false, code, error}`.
5. The reply travels back as `{type: "result", id, result}`.

Security model: Instagram's own scripts could post the same window message, so nothing from the page is trusted. The page can only ever supply a shortcode and a plain file name. The host never accepts a URL or a path, and `allowed_origins` in the host manifest limits who can start it to this extension's ID.

Helper actions: `ping` (returns yt-dlp path and version, ffmpeg path, download folder, cookie setting, config path) and `download`.

yt-dlp arguments used:

```
--no-playlist --no-progress --no-warnings --force-overwrites
--format "bv*+ba/b" --merge-output-format mp4
--paths <download_dir> --output "<name>.%(ext)s"
--no-simulate --print "after_move:%(filepath)s\t%(width)sx%(height)s"
[--cookies-from-browser <browser>]   second attempt only
-- https://www.instagram.com/reel/<code>/
```

## How History works

One `tick()` runs every 400 ms. It works out which source the current page belongs to, asks that source for the shortcodes visible right now, and logs any new ones with the current time.

Sources are entries in the `SOURCES` array: `{id, label, test(path), collect(), timed?, scroller?, byUser?}`. The first whose `test` matches wins. Pages that match none are not logged. A post opened in a pop-up (`/p/ID/` or `/reel/ID/`) keeps the source underneath live.

| Source | Page | Detection | Notes |
| --- | --- | --- | --- |
| Home | `/` | Each post is an `<article>`. Reels carry an `a[href="/reels/ID/"]`. | Instagram preloads posts below the fold, so only the article crossing the vertical middle of the window is logged. |
| Reels | `/reels/ID/` | Shortcode read from the address bar. | The feed has no reel links in the DOM. Instagram calls `history.replaceState` as each reel snaps into view. |
| Saved | `/<user>/saved/...` | Tiles are `a[href="/p/ID/"]`. A reel is a tile with `svg[aria-label="Clip"]`. | Fallback for non-English UIs: SVG path `d` starting `M22.942 7.464`. The grid is virtualised (about 17 rows in the DOM), so collection is continuous. |
| Likes | `/your_activity/interactions/likes/` | Tiles are `div[role="button"][aria-label]` with an `img[src*="ig_cache_key"]`. | See the decoding notes below. Videos only, identified by the label starting with "Video" (English UI). |
| Profiles | `/<user>/reels/` | Tiles are `a[href="/<user>/reel/ID/"]`. Only tiles whose username matches the address bar are logged. | Seen live on one profile. The username filter stops tiles left over from the previous profile being logged under the new one during a SPA swap. `byUser`: each entry stores the username and the tab is sectioned by it, current profile first, then by most recent logging. |

Likes decoding:

- The likes page is built with Bloks. Tiles have no link and no ID in their React props.
- The thumbnail URL has an `ig_cache_key` parameter: base64 of a digit string, then a suffix like `.3-ccb7-5`.
- The digit string is either the media ID alone (19 digits today) or the media ID with a second ID glued on (35 or 36 digits seen).
- Media IDs are snowflakes: `ms = (id >> 23) + 1314220021721`.
- The shortcode is the media ID written in base 64 with the alphabet `A-Za-z0-9-_`.
- The script tries prefix lengths 19, 18, 17 and keeps the one whose built-in date matches the "shared <date>" in the tile's `aria-label` (label format: `Video, 1 of 18, by @user, shared October 1, 2026`). Without a readable label it takes the first ID not dated in the future.
- Verified on the live page: 27 of 27 tiles matched their shared date, and fetching one rebuilt link returned the right post.
- The Likes grid scrolls inside its own container, not the window. Auto-scroll finds that container by walking up from a tile.

Storage:

- `chrome.storage.local` (with `unlimitedStorage`), one key per source, value is an array of `[shortcode, unixSeconds]` in logging order. Profiles entries are `[shortcode, unixSeconds, username]`. Settings in `igHistory.settings`.
- Survives clearing instagram.com site data. Deleted when the extension is removed (not when it is reloaded).
- Loading is async. Nothing is logged, cleared or imported until it finishes (`ready`), and if it fails nothing is saved, so a failed read can never overwrite the history.
- One-time migration: if `igHistory.migrated` is not set, the page localStorage keys (`igHistory.v2.*`, `igHistory.settings`, v0.2 `igHistory.v1`) are merged in, written, and only then removed from localStorage. Removing them stops a reinstall from bringing back links that were cleared since.
- `chrome.storage.onChanged` keeps several open tabs in step. It also fires in the writing tab, with a value that can be older than what that tab has logged since, so every write includes `igHistory.writer = {tab, n}` and a tab ignores its own echo. Two tabs writing the same key at the same moment is still last-writer-wins.
- Every save rewrites the whole source key, as before.
- Backup (Settings tab): Export writes `{app: "insta-tools", format: 1, exported, settings, history: {sourceId: entries}}` to `insta-tools-history-YYYY-MM-DD.json` through a blob `<a download>`. Import merges: only new shortcodes are added, the log is re-sorted by time, existing entries and the prefix are kept (the backup's prefix is used only if none is set).

Panel behaviour:

- Shadow DOM host at bottom right (`right: 20px; bottom: 84px`, clear of the Messages pill). Styles go in through `adoptedStyleSheets`.
- Tabs per source, labels only (counts and the live dot were removed on request). The History button badge is the total across all tabs; its tooltip lists each tab's count. The panel follows the page to its tab, and the header says which source is logging.
- Day sections: Today, Yesterday, weekday names (2 to 6 days), Last week (7 to 13), "N weeks ago" (14 to 27), then month and year. Sections are `<details>` and rows are only built for open sections.
- Newest logged first on every tab. A new row is highlighted yellow for 5 seconds. Because the list is rebuilt on every change, the row uses a negative `animation-delay` so the fade resumes instead of restarting.
- Click a link to copy it. Middle click and ctrl/cmd click open it.
- Settings tab: a copy prefix (`igHistory.settings`, `{prefix}`) is put before every copied link. Displayed links stay plain. `view` always stays a source id and `settingsOpen` shows the pane instead, so code indexing `logs[view]` is unaffected. The pane is built once and only hidden or shown, because the list is rebuilt on every log and would steal focus from the field.
- Auto-scroll on Saved and Likes stops after 6 idle rounds of 1.2 seconds.
- Clear needs a second click within 3 seconds and only clears the tab in view.

## How Download works

A `scan()` runs every 500 ms. It removes buttons whose media has gone (slides and feed posts are recycled), then adds a button to every qualifying image or video.

Qualifying media: an `img` inside `main`, `article` or `[role="dialog"]`, or a `video` anywhere, at least 200 px rendered, and not inside an `<a>`, except a video inside an `a[href="/reels/ID/"]`. Grid tiles and avatars are inside links (`/p/ID/`, `/username/reel/ID/`), post media is not. Paths under `/direct` and `/stories` are skipped.

Where the button goes: the media sits in a stack of same-sized wrapper divs, with click-catching overlays as siblings partway up. `frameFor()` walks up to 12 levels, stops at `LI`/`UL` or when the size differs by more than 2 px, and takes the outermost positioned wrapper. That puts the button above every overlay. An image whose frame also contains a video is a poster and is skipped.

Findings from the live pages:

- Images: the feed `img` has no `srcset` and its `src` is already the full size file (3072x4096, 1440x1438 and 1080x1350 were seen). `imageSource()` still picks the widest `srcset` candidate if one exists.
- Image wrappers: `img(absolute) < div(relative) < div(relative, 2 children: image wrapper + overlay) < ...`.
- Galleries: slides are `li` elements positioned with `transform: translateX(index * width)`. Only two or three are in the DOM at a time. The slide number in the file name comes from that transform.
- Post page (`/p/ID/`): no `<article>`, the media is inside `main`, same wrapper structure. "More posts" tiles are inside links and are ignored.
- Videos: `video.src` is a `blob:` stream. Walking up the React fiber from the `<video>` (about 12 levels) reaches props with `implementations[].data = {hdSrc, sdSrc, hdSrcPreferred, mediaStream}`. `hdSrc` is a complete MP4 on fbcdn with video and audio in one non-fragmented file. On the reels checked it was 720x1280 and identical to `sdSrc`.
- The same fiber chain also holds a DASH manifest as an XML string (`props.manifest` near the video, `implementation.data.manifest` higher up). It lists video-only representations up to 1080x1920 at about 2.9 Mbps and a separate audio track at about 65 kbps.
- `fetch()` of CDN image and video URLs works from the page world (CORS and CSP both allow it). A cross-origin `<a download>` does not, which is why files are fetched to a blob first.
- Feed reels: Instagram puts its own "More Options" control inside the video at about right 10, top 13. `place()` detects any small control overlapping the button's box and drops the button to `top: 52px`.
- Feed reels (seen live 6 Oct 2026): the `<video>` is about 16 levels inside a full-size `a[href="/reels/ID/"]` (role link, same box as the video) that opens the Reels viewer. The old "never inside a link" rule skipped every feed reel. The frame stays inside the link, and the shortcode is taken from it, because the address bar is `/`.
- Reels viewer opened from the feed (seen live 6 Oct 2026): the address becomes `/reels/ID/` but the viewer is an overlay of plain divs (close button at top right) outside `main`, `article` and any dialog. The home feed stays in `main` underneath. No stable container to select, hence videos from anywhere. Starting on `/reels/` directly puts the viewer in `main`, which is why that case always worked.
- Reels page: the top right of the video is free. A full-size `div[role="button"][aria-label="Video player"]` covers the video. Author links there are `/username/reels/`, not `/username/`.

File names: `author_shortcode[_slide].ext`.

- Author: the highest profile link (by screen position) in the nearest ancestor block that has one. For images, links inside the frame are skipped because those are tagged people. For videos they count, because the header can be overlaid on the video.
- Shortcode: from the address bar if it is a post or reel URL, otherwise the first post link in the surrounding `article`, dialog or `main`.

Video download order:

1. Single-video posts and reels: ask the helper (yt-dlp). Button goes green, tooltip shows resolution and path.
2. If the helper is missing or fails: save `hdSrc` from the page. Button goes amber, tooltip says why.
3. Video slides inside a gallery: always saved from the page, because yt-dlp downloads a whole post, not one slide.

## Decisions and reasons

- Poll on a timer instead of using a MutationObserver. Address bar changes fire no event, and the DOM queries are cheap.
- History moved from page localStorage to `chrome.storage.local` (originally it stayed in localStorage so userscript history carried over with no migration). Reason: clearing site data, "clear on exit" and Instagram's own code could all wipe localStorage. The trade-off is that removing the extension now deletes it, hence Export.
- Build UI with `createElement`, never `innerHTML`, and add styles with constructed stylesheets. This avoids Instagram's CSP and any Trusted Types enforcement.
- History in Saved and Likes is ordered by when it was logged, newest first. After an auto-scroll that is the reverse of page order. This was a deliberate choice; the alternative (keep page order, only flash new rows) was offered and not taken.
- Home logs only what crosses mid-screen, so History means "seen", not "loaded".
- yt-dlp is tried without a login first and only retried with `--cookies-from-browser` if that fails. Requests made with the browser's session count as account activity outside the browser and can be rate limited.
- The helper takes a shortcode, never a URL, and its download folder comes from its own config file, never from the extension.
- The login retry reads cookies through yt-dlp itself. The extension does not have the `cookies` permission and never handles session cookies.

## What was tested

Tested:

- History and both download paths against mock pages in Playwright that mirror Instagram's markup.
- The real extension loaded in Chromium (Playwright, `channel: "chromium"`, `--load-extension`), with the native host registered and a fake `yt-dlp` behind it: helper success, yt-dlp failure with fallback, helper not installed with fallback, gallery video and image never touching the helper, the popup in both states, and the pinned ID matching.
- The host on its own: message framing, retry order, rejection of bad codes and names (path traversal, option injection, shell characters), unknown actions.
- `install.sh` and `uninstall.sh` against a throwaway home folder, including a path with spaces.
- History storage with the real extension loaded (mock pages): migration from seeded localStorage (including v0.2 and Profiles usernames, page keys removed, unrelated keys kept), two tabs staying in step, a tab continuing to log after its own write echoes, Export download contents, Clear then Import restoring links, re-import reporting nothing new, a non-backup file rejected, and reload with no second migration. Settings prefix and Profiles grouping in a mock page.
- On the real Instagram pages: every detection method above, History v0.1 and v0.2 injected live, image button placement on the feed, video button placement and source lookup on the Reels page, and fetches of one real image and one real MP4.

Not tested:

- Real yt-dlp against Instagram. The build sandbox had no yt-dlp and no Instagram login. This is the biggest unknown.
- The extension loaded in the real Chrome profile.
- A real click-to-save on instagram.com for either images or videos (only the fetch was checked live).
- The post pop-up opened from a profile grid.
- The "drop below More Options" placement on a real feed reel (mock only).
- The Clip icon path fallback and anything on a non-English UI.
- Profile grids beyond one Reels tab, and `/reel/ID/` pages.
- Export's blob download and the migration on the real instagram.com (CSP and the user's actual localStorage history).
- macOS and other browsers for the helper.

How the tests were built, for recreating them:

- Mock pages: `context.route("**/*")` serves hand-written HTML for `https://www.instagram.com/...` and tiny JPEG and MP4 bodies for a fake CDN host with `access-control-allow-origin: *`.
- Videos: attach a fake fiber to the element, `video["__reactFiber$test"] = {memoizedProps: {}, return: {memoizedProps: {implementations: [{data: {hdSrc, sdSrc}}]}}}`.
- Extension end to end: `chromium.launchPersistentContext(profileDir, {channel: "chromium", headless: true, args: ["--disable-extensions-except=...", "--load-extension=..."]})`. Put the host manifest in `<profileDir>/NativeMessagingHosts/`. Point it at a wrapper script that sets `XDG_CONFIG_HOME` to a test config whose `yt_dlp` is a fake script.
- History grouping: seed `localStorage` with entries at different ages before loading the script.

The test scripts themselves were throwaway and are not in the repo. Adding a `tests/` folder built on the approach above would be a good early task.

## Known gaps and next steps

1. Install for real and try a reel. Check the popup first, then watch the button colour and tooltip.
2. If yt-dlp is unreliable on Instagram: have the helper merge the 1080p streams the page already exposes. The page would pass the best video URL and the audio URL from the DASH manifest, and the helper would run `ffmpeg -c copy`. That needs no login and no extractor. The host would need to accept two URLs, restricted to `https` on `*.fbcdn.net` and `*.cdninstagram.com`.
3. Download progress. The host could stream progress messages over the native port and the button could show a percentage.
4. Gallery "download all". Needs either stepping through slides or Instagram's API, because only two or three slides are in the DOM.
5. A dwell time for Home and Reels history, so quick flicks are not logged.
6. An on/off switch per tool in the popup. The tools run in the page world, so the setting would have to travel through the bridge.
7. Done: History is in `chrome.storage.local`, with Export and Import.
8. Windows helper install (registry entry plus a `.bat` wrapper). Note that `--cookies-from-browser chrome` is unreliable on Windows.
9. Flatpak and Snap Chrome use different profile paths and are not covered by `install.sh`.
10. Repo housekeeping: a licence file, a `tests/` folder, and a decision on whether to keep the old userscripts in a `legacy/` folder.

## Gotchas

- Instagram pauses lazy loading and address bar updates in background tabs (it relies on IntersectionObserver). Auto-scroll and Reels logging only work with the tab in the foreground. This also affects any automated testing against a hidden tab.
- Instagram is a single page app. Never assume a page load between routes.
- If the old Tampermonkey scripts are still enabled, their load guards can win the race and the extension's copies bail out. The symptom is no yt-dlp path and no amber or green tooltips.
- After reloading the extension on `chrome://extensions`, open Instagram tabs keep a dead bridge. The button tooltip says "Extension was reloaded. Refresh this tab."
- Chrome can start the helper with a shorter PATH than a terminal. The host adds common folders, and the config file takes full paths.
- The helper's stdout is the message channel. Anything a child process prints there would corrupt it, which is why yt-dlp runs with stdin closed and output captured.
- When inspecting instagram.com through Claude in Chrome, tool output containing URL query strings is blocked. Return path names, counts and booleans instead of raw URLs.
- Tampermonkey in Chrome needs "Allow User Scripts" or Developer mode. Only relevant if going back to the userscripts.

## Version history

Instagram History (userscript):

- 0.1: floating button, reel links on the Saved page.
- 0.2: tabs per source, Reels feed via the address bar, localStorage.
- 0.3: timestamps, day sections, two-click Clear, per-section Copy.
- 0.4: Likes tab via thumbnail cache key decoding.
- 0.5: Home tab, removed the catch-all Other tab.
- 0.6: newest first everywhere, yellow highlight on new links.
- 0.7: click a link to copy it.

Instagram Image Download (userscript):

- 0.1: buttons on post and gallery images.
- 0.2: videos and reels via the React player props (720p MP4).

Insta Tools (extension):

- 1.0.0: both tools merged, bridge and service worker, native helper running yt-dlp, popup with helper status.
- Unreleased: Profiles tab, Settings tab (copy prefix, Export, Import), plain tab labels, History in `chrome.storage.local` running in the isolated world.

## Conventions

- Plain JavaScript, no build step, no dependencies. Python 3 standard library only for the helper.
- Comments explain why something is done, not what the line does.
- User-facing text is plain and short. No em dashes.
- Every Instagram-specific selector or pattern is a named constant at the top of its file, with a comment on what was observed.
