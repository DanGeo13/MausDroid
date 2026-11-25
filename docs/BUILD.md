# Building MausDroid

Needs: Node 22, Java 17, Go 1.24, Android SDK (platform 35, build-tools 35,
NDK 27.2.12479018, CMake 3.22.1).

```bash
./scripts/fetch-native.sh      # libnode.so (nodejs-mobile 18.20.4) + builds libtsbridge.so
./scripts/package-engine.sh    # engine + UI → APK assets and dist/updates
cd android && ./gradlew assembleRelease
```

Engine tests (use Node 18 to match the phone):

```bash
cd engine && ENGINE_NODE=/path/to/node18 node --test test/*.test.mjs
```

The relay test runs when `npx wrangler dev` is running in `relay/`.

Run the engine on a computer for UI work: `cd engine && node build.mjs && node dist/engine.cjs`
(it prints a local link). Phone-only features (browser, notifications,
Tailscale) report that they need the Android app.
