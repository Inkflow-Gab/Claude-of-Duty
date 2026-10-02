# APK project — how to build

**I cannot build this in the sandbox I work in: there is no Android SDK there**
(no `gradle`, `sdkmanager`, `adb`, `apksigner` or `aapt2`; only a bare JDK 17).
So `android/` is written complete and correct but **unbuilt**, and the `.apk` has
to be produced on a machine with the Android SDK. Everything it needs is in this
repo.

## The important thing to know first

**An APK will not make the game faster.** It is the same WebView, the same GPU and
the same WebGL2 extension set as the browser. What it genuinely buys you:

| | browser | APK |
|---|---|---|
| landscape | requested from JS, iOS refuses | **locked in the manifest, always** |
| address bar / status bar | takes ~15% of height, appears and hides | **gone, permanently** |
| pull-to-refresh reloads the game | possible, and it loses your session | **impossible** |
| works offline after first load | no | **yes** — assets are local, not from GitHub |
| install friction | a URL | a real app icon |
| viewport resize on scroll | needs `visualViewport` handling | **not a concern, no browser chrome** |
| boot | fetches 1.6 MB from GitHub every time | **loads from local storage** |

The last two are real wins and the reason to bother. The performance work is
unrelated to packaging and lives in the quality presets.

## Build it

On a machine with the Android SDK (Android Studio is the easy way):

```bash
# 1. Node deps
npm install
npm run build            # -> dist/

# 2. Sync dist/ into the Android project
npx @capacitor/cli sync android

# 3. Open in Android Studio, or build from the command line:
cd android && ./gradlew assembleDebug
# -> android/app/build/outputs/apk/debug/app-debug.apk
```

`assembleRelease` needs a signing key; without one Gradle will still emit an
unsigned APK, which will not install.

I have **not** run any of this. The `android/` tree is written from the standard
Capacitor layout but has never been synced, compiled, or run on a device, so
treat the first `gradlew` as a debugging session. The web half — the `dist/` it
wraps — is what I have actually verified, and only partially.

## Why Capacitor and not a plain WebView

Because the alternative means hand-writing the glue: a native activity that owns
a `WebView`, a `WebViewClient` for the back button, lifecycle handling, file
loading, and asset packaging. Capacitor is that, already written and maintained,
and it is a dev dependency — it adds nothing to the shipped game, which is still
one `three` dependency and no external assets.

## What the wrapper changes in the manifest

See `android/app/src/main/AndroidManifest.xml`. The load-bearing bits:

- `android:screenOrientation="sensorLandscape"` — the landscape lock, enforced by
  the OS rather than requested politely by JS
- `android:hardwareAccelerated="true"` — explicit, because a WebGL game on a
  device that somehow disables this gets a black screen and no error
- `allowBackup=false` — the game keeps no user data worth backing up, and
  `localStorage` (the settings store) should not be restored onto a different
  device, where the saved quality override would be wrong for that hardware
- no `INTERNET` permission is needed for the game itself, and it is deliberately
  omitted. If the wrapper is pointed at `https://` rather than the bundled
  assets, it will need `android:usesCleartextTraffic` handling, which is a
  security downgrade — another reason the build should serve the local `dist/`.

## If it shows a black screen in the APK

The game's own diagnostics still work, and that is the point of having built them:
a boot failure renders a readable panel with the file, line and stack, and a GPU
that cannot do float render targets says so in plain language. Both survive
being wrapped, because they are DOM inside the page.
