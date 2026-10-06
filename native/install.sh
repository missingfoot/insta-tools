#!/usr/bin/env bash
# Registers the Insta Tools helper with your Chromium-based browsers, so the
# extension is allowed to start it. Run it again if you move this folder.
#
#   ./install.sh                 use the extension ID that manifest.json pins
#   ./install.sh <extension-id>  use a different ID (shown on chrome://extensions)
set -euo pipefail

HOST_NAME="com.jamessparkes.insta_tools"
EXTENSION_ID="${1:-aiiebmkfkohfbicheaecifejllipofdd}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="$DIR/insta_tools_host.py"

command -v python3 >/dev/null || { echo "python3 is required and was not found."; exit 1; }
chmod +x "$HOST"

case "$(uname -s)" in
  Linux)
    BROWSERS=(
      "$HOME/.config/google-chrome"
      "$HOME/.config/google-chrome-beta"
      "$HOME/.config/chromium"
      "$HOME/.config/BraveSoftware/Brave-Browser"
      "$HOME/.config/microsoft-edge"
      "$HOME/.config/vivaldi"
    ) ;;
  Darwin)
    BROWSERS=(
      "$HOME/Library/Application Support/Google/Chrome"
      "$HOME/Library/Application Support/Chromium"
      "$HOME/Library/Application Support/BraveSoftware/Brave-Browser"
      "$HOME/Library/Application Support/Microsoft Edge"
      "$HOME/Library/Application Support/Vivaldi"
    ) ;;
  *) echo "Unsupported system: $(uname -s). See the README for Windows."; exit 1 ;;
esac

installed=0
for browser in "${BROWSERS[@]}"; do
  [ -d "$browser" ] || continue
  mkdir -p "$browser/NativeMessagingHosts"
  python3 - "$browser/NativeMessagingHosts/$HOST_NAME.json" "$HOST_NAME" "$HOST" "$EXTENSION_ID" <<'PY'
import json, sys
target, name, host, extension_id = sys.argv[1:5]
manifest = {
    "name": name,
    "description": "Insta Tools helper (runs yt-dlp)",
    "path": host,
    "type": "stdio",
    "allowed_origins": [f"chrome-extension://{extension_id}/"],
}
with open(target, "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, indent=2)
    handle.write("\n")
PY
  echo "Registered with $browser"
  installed=$((installed + 1))
done

if [ "$installed" -eq 0 ]; then
  echo "No supported browser profile folder was found. Nothing was registered."
  exit 1
fi

echo
echo "Helper:       $HOST"
echo "Extension ID: $EXTENSION_ID"
if command -v yt-dlp >/dev/null; then echo "yt-dlp:       $(command -v yt-dlp) ($(yt-dlp --version 2>/dev/null || echo unknown))"; else echo "yt-dlp:       NOT FOUND. Install it before downloading videos."; fi
if command -v ffmpeg >/dev/null; then echo "ffmpeg:       $(command -v ffmpeg)"; else echo "ffmpeg:       NOT FOUND. yt-dlp needs it to merge full quality video and audio."; fi
echo
echo "Done. Open the Insta Tools popup in the browser to check the helper is connected."
