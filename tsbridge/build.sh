#!/usr/bin/env bash
# Builds tsbridge for Android arm64 with the NDK (cgo on, so DNS uses Android's resolver).
set -euo pipefail
cd "$(dirname "$0")"
NDK="${ANDROID_NDK_HOME:-/opt/android-sdk/ndk/27.2.12479018}"
OUT="../android/app/src/main/jniLibs/arm64-v8a"
mkdir -p "$OUT"
CC="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android28-clang" \
CGO_ENABLED=1 GOOS=android GOARCH=arm64 \
go build -trimpath -ldflags="-s -w -extldflags=-Wl,-z,max-page-size=16384" -o "$OUT/libtsbridge.so" .
echo "built $OUT/libtsbridge.so"
