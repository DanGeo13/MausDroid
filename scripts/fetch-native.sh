#!/usr/bin/env bash
# Gets the two native pieces that are too big for git:
#  - libnode.so (nodejs-mobile 18.20.4, the JavaScript runtime)
#  - libtsbridge.so (built-in Tailscale, compiled from ./tsbridge)
set -euo pipefail
cd "$(dirname "$0")/.."
LIBS=android/app/src/main/jniLibs/arm64-v8a
mkdir -p "$LIBS" android/app/src/main/cpp/libnode
if [ ! -f "$LIBS/libnode.so" ]; then
  tmp=$(mktemp -d)
  curl -sSL -o "$tmp/nm.zip" https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v18.20.4/nodejs-mobile-v18.20.4-android.zip
  unzip -q "$tmp/nm.zip" -d "$tmp/nm"
  cp "$tmp/nm/bin/arm64-v8a/libnode.so" "$LIBS/"
  rm -rf android/app/src/main/cpp/libnode/include
  cp -r "$tmp/nm/include" android/app/src/main/cpp/libnode/
  rm -rf "$tmp"
fi
if [ ! -f "$LIBS/libtsbridge.so" ]; then
  ./tsbridge/build.sh
fi
echo "native libraries ready"
