#!/usr/bin/env bash
# Removes the helper registration added by install.sh. Downloaded files and
# your config file are left alone.
set -euo pipefail
HOST_NAME="com.jamessparkes.insta_tools"
for browser in \
  "$HOME/.config/google-chrome" "$HOME/.config/google-chrome-beta" "$HOME/.config/chromium" \
  "$HOME/.config/BraveSoftware/Brave-Browser" "$HOME/.config/microsoft-edge" "$HOME/.config/vivaldi" \
  "$HOME/Library/Application Support/Google/Chrome" "$HOME/Library/Application Support/Chromium" \
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser" "$HOME/Library/Application Support/Microsoft Edge" \
  "$HOME/Library/Application Support/Vivaldi"; do
  target="$browser/NativeMessagingHosts/$HOST_NAME.json"
  if [ -f "$target" ]; then rm "$target"; echo "Removed $target"; fi
done
echo "Done."
