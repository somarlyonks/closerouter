#!/bin/bash
# Embed the server binary into the app bundle.
#
# The server binary is an explicit, always-fresh dependency of the app build:
# it is rebuilt on every app build and `dist/closerouter` is never trusted
# merely because it exists. A failed server build fails the app build.
set -euo pipefail

cd "$SRCROOT/.."

# Xcode launched from the GUI (Dock/Finder) inherits a minimal PATH without
# npm, and every build now hard-requires it; fall back to the usual install
# locations before giving up.
if ! command -v npm >/dev/null 2>&1; then
    for dir in /opt/homebrew/bin /usr/local/bin "$HOME"/.nvm/versions/node/*/bin; do
        if [ -x "$dir/npm" ]; then export PATH="$dir:$PATH"; fi
    done
fi

echo "building closerouter (always-fresh app build dependency)..."
npm run build:cli

RES="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH"
mkdir -p "$RES"
cp "dist/closerouter" "$RES/closerouter"
codesign --force --sign - "$RES/closerouter"

echo "embedded closerouter $("$RES/closerouter" version 2>/dev/null || echo '?') (sha256 $(shasum -a 256 "$RES/closerouter" | cut -c1-12))"
