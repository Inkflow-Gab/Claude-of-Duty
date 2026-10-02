# The APK — status and how it is built

**The debug APK is built, by CI, and downloadable right now:**

- Permanent link (GitHub release, this repo's sibling `Inkflow-Gab/black-of-duty-apk`):
  https://github.com/Inkflow-Gab/black-of-duty-apk/releases/download/v1.0.0/BlackOfDuty-debug.apk
- The same file also sits in this project root as `BlackOfDuty-debug.apk` (local copy, not committed).
- The CI Actions artifact lives for 90 days per run; the release link is permanent.

Install it with "install from unknown sources" allowed for your browser/downloads
app. It is a debug build signed with Android's auto-generated debug keystore,
which is why a normal device will accept it.

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

## How it is built (nothing runs on the phone)

Android projects are big, and a committed `android/` tree is a merge-conflict
nightmare across Capacitor upgrades. So the APK is built from the
`Inkflow-Gab/black-of-duty-apk` repository, which holds only the intent:

- `.github/workflows/build-apk.yml` — the whole pipeline, on GitHub's runners
- `build-apk.sh` — clones the game repo, `npm ci` + `vite build` (with
  `BASE_PATH='/'` — the Pages subpath base would 404 every asset inside an APK),
  `npx cap add android` + `cap sync` to generate the native project and bundle
  `dist/` into it, applies the overrides below, and FAILS if the bundle
  references `/Claude-of-Duty/`
- `capacitor.config.json` — plain JSON on purpose: a `.ts` config needs a local
  TypeScript install in CI, and a stale `.ts` silently beats the JSON unless it
  is deleted first
- `android-overrides/{AndroidManifest.xml,MainActivity.java,strings.xml}` — the
  three files that carry actual intent (see below)

The pipeline went through nine real CI failures before going green — each one a
different, separately diagnosed trap (YAML `:` vs shell `=`, a packaged named
`tools` that Google deleted, `@latest` vs a pinned major, Node 20 vs Capacitor
8's Node 22 requirement, a TypeScript config, JDK 17 vs Capacitor 7's Java 21
target, `working-directory` pointing at a directory that never existed, and two
resource collisions with the template). The comments inside the workflow and
`build-apk.sh` document each one at the spot it occurred, so the reader sees the
trap before stepping in it.

## What the wrapper changes in the manifest

See `android-overrides/AndroidManifest.xml` (the generator's own manifest is
replaced wholesale, not sed-patched). The load-bearing bits:

- `android:screenOrientation="sensorLandscape"` — the landscape lock, enforced by
  the OS rather than requested politely by JS
- `android:hardwareAccelerated="true"` — explicit, because a WebGL game on a
  device that somehow disables this gets a black screen and no error
- `allowBackup=false` — the game keeps no user data worth backing up, and
  `localStorage` (the settings store) should not be restored onto a different
  device, where the saved quality override would be wrong for that hardware
- **no permissions at all** — not even `INTERNET`. The wrapper serves the
  bundled `dist/`, not the github.io URL: the game needs no network, and an APK
  that cannot fetch cannot phone home even if the page were modified to try.

`MainActivity.java` is the whole native surface: landscape lock (manifest), full
immersive mode (`goImmersive`, re-applied on every focus change because the bars
come back after a notification shade pull), and `FLAG_KEEP_SCREEN_ON` so the
display never sleeps mid-fight. Everything else — input, quality tiers, loading
screen, HUD — is the same code the browser runs, which is exactly why the two
builds cannot drift apart.

The splash background is `#07090b`, the exact background of the in-page loading
screen, so the system splash → WebView first paint → loading screen handoff is
one seamless colour with no flash.

## If it shows a black screen in the APK

The game's own diagnostics still work, and that is the point of having built them:
a boot failure renders a readable panel with the file, line and stack, and a GPU
that cannot do float render targets says so in plain language. Both survive
being wrapped, because they are DOM inside the page.