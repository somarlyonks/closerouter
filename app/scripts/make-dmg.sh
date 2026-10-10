#!/bin/bash
# Package the built app bundle into a distributable disk image (.dmg).
#
# Produces the conventional drag-to-install layout: the app next to an
# "Applications" alias, so the user drags CloseRouter.app onto it. Uses only
# built-in macOS tools (hdiutil, PlistBuddy) - no third-party dependencies.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/.."

APP_PATH="${1:-dist/CloseRouter.app}"
if [ ! -d "$APP_PATH" ]; then
    echo "app bundle not found: $APP_PATH (run 'npm run build:app' first)" >&2
    exit 1
fi

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_PATH/Contents/Info.plist")"
DMG_PATH="dist/CloseRouter.dmg"
VOLUME_NAME="CloseRouter"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# ditto preserves symlinks, extended attributes and the code signature.
ditto "$APP_PATH" "$STAGE/CloseRouter.app"
ln -s /Applications "$STAGE/Applications"

rm -f "$DMG_PATH"
diskutil image create from \
    --volumeName "$VOLUME_NAME" \
    --format UDZO \
    "$STAGE" \
    "$DMG_PATH"

echo "built $DMG_PATH ($(du -h "$DMG_PATH" | cut -f1)), CloseRouter $VERSION"
