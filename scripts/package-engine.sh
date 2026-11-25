#!/usr/bin/env bash
# Builds the engine + UI and packs it into the APK's assets (the built-in
# version) and into dist/updates/ (for over-the-air updates).
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p 'require("./version.json").engine')
(cd engine && npm ci --silent && node build.mjs)
mkdir -p android/app/src/main/assets dist/updates
rm -f android/app/src/main/assets/engine.zip "dist/updates/engine-$VERSION.zip"
(cd engine/dist && zip -qr "../../dist/updates/engine-$VERSION.zip" engine.cjs ui)
cp "dist/updates/engine-$VERSION.zip" android/app/src/main/assets/engine.zip
echo "$VERSION" > android/app/src/main/assets/engine-version.txt
echo "engine $VERSION packaged"
