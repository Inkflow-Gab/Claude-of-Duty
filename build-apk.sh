#!/usr/bin/env bash
#
# Generate the Capacitor Android project and apply our patches.
#
# WHY THE PROJECT IS GENERATED RATHER THAN COMMITTED
#
# A Capacitor android/ tree is large and almost entirely boilerplate: gradle
# wrapper binaries, a version catalogue, res/ variants, generated BuildConfig.
# Committing it means every Capacitor upgrade is a merge conflict across a
# hundred generated files, and nobody reviews those diffs.
#
# `npx cap add android` produces a correct tree for the installed Capacitor
# version in a few seconds, and `npx cap sync` keeps it current. So the tree is
# generated here and only the three files that carry actual intent are kept in
# this repository and copied over the top:
#
#   android-overrides/AndroidManifest.xml  the manifest — landscape lock,
#                                        no permissions, hardware acceleration
#   android-overrides/MainActivity.java    immersive mode and keep-screen-on
#   android-overrides/strings.xml          the app name
#
# The alternative — hand-writing the whole tree — is what produced the version of
# this repo that could never be built, because it had never been synced.
set -euo pipefail

GAME_DIR="${GAME_DIR:-game}"
OUT="${OUT:-android}"

echo "==> Capacitor config"
# Delete any TypeScript/JS config the game might carry BEFORE copying ours in,
# because Capacitor does not merge configs — it picks exactly one, in a fixed
# precedence order:
#
#     capacitor.config.ts  >  capacitor.config.js  >  capacitor.config.json
#
# So a stale `capacitor.config.ts` in the game repo silently beats the JSON we
# just wrote, and the resulting failure is a lie about the cause:
#
#     [error] Could not find installation of TypeScript.
#            To use capacitor.config.ts files, you must install TypeScript...
#
# Read that message and you conclude the fix is `npm install -D typescript` —
# which "works", and makes things worse, because the stale config is now really
# in force and our `androidScheme: 'https'` is not. This repository owns the
# config, so it also owns the absence of any competing one.
rm -f "$GAME_DIR/capacitor.config.ts" "$GAME_DIR/capacitor.config.js"
cp capacitor.config.json "$GAME_DIR/capacitor.config.json"

cd "$GAME_DIR"

echo "==> Installing Capacitor"
# PINNED TO @7, and this was a real bug rather than a nicety. The workflow runs
# Node 20, and `@capacitor/cli@latest` is currently 8.x, which requires Node >=22
# — the CLI refused to generate the Android project with
# "[fatal] The Capacitor CLI requires NodeJS >=22.0.0". `@latest` changes
# meaning under you; a version range does not. Capacitor 7 supports Node 20 and
# is the newest major that does.
npm install --no-save --no-audit --no-fund \
  @capacitor/cli@^7 \
  @capacitor/core@^7 \
  @capacitor/android@^7

echo "==> Generating the Android project"
rm -rf "$OUT"
npx cap add android

echo "==> Applying our overrides"

# The manifest. Copied wholesale rather than patched with sed: a manifest edited
# by pattern-matching is a manifest that silently stops being enforced the next
# time a line's whitespace changes.
cp ../android-overrides/AndroidManifest.xml \
   "$OUT/app/src/main/AndroidManifest.xml"

# The activity. Needs its directory to exist first; the generated project has
# MainActivity but not in our package path.
ACTIVITY_DIR="$OUT/app/src/main/java/com/blackofduty/game"
mkdir -p "$ACTIVITY_DIR"
cp ../android-overrides/MainActivity.java "$ACTIVITY_DIR/MainActivity.java"

# The app name, so the launcher shows "Black of Duty" rather than the default.
cp ../android-overrides/strings.xml "$OUT/app/src/main/res/values/strings.xml"

# The splash background is written to match the in-page loading screen exactly.
# A system splash in one colour and a page background in another produces a
# visible flash on every launch, which reads as two separate problems.
#
# ORDER IS LOADING-BEARING: delete what the template shipped, THEN write ours.
# The previous version wrote splash.xml first and swept up after it, and the
# sweep took ours with it — the build then failed at resource link time with
#
#     error: resource drawable/splash not found
#
# because the template's styles.xml references @drawable/splash and our file was
# the only thing providing it. A sweep that runs last deletes whatever the
# current step just produced; that ordering is the entire difference.
if [ -d "$OUT/app/src/main/res" ]; then
  # Delete EVERY splash variant the Capacitor template shipped, not just the one
  # in the bare `drawable/` folder, and not just the one that collides. Two
  # distinct problems, only the first of which is loud:
  #
  #   1. `drawable/splash.xml` alongside `drawable/splash.png` is two resources
  #      of the same name and type in one folder, and aapt2 rejects it outright:
  #         Duplicate resources
  #      That is the visible failure and the easy one.
  #
  #   2. The template also ships `drawable-{m,h,xh,xxh,xxxh}dpi/splash.png`.
  #      Deleting only the duplicate would let the build go green and leave every
  #      real device showing the template's splash image instead of our colour —
  #      because a density-qualified resource outranks the unqualified fallback,
  #      which is exactly the resource we just wrote. The build would be fixed
  #      and the flash-on-launch we set out to remove would still be there, and
  #      only on hardware.
  #
  # So: all of them, by name, everywhere. THEN write ours — after a clear
  # res/ tree, so nothing we produce can be swept up.
  find "$OUT/app/src/main/res" -name 'splash.*' -print -delete
  mkdir -p "$OUT/app/src/main/res/drawable" "$OUT/app/src/main/res/values"
  cat > "$OUT/app/src/main/res/drawable/splash.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<!--
  Matches the loading screen's background exactly (#07090b) so the handoff from
  the system splash, through the WebView's first paint, to the in-page screen is
  seamless. A mismatch here is a visible flash on every single launch.
-->
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:drawable="@color/splashBackground" />
</layer-list>
XML
  # Declared with a literal colour rather than a resource reference so the file
  # cannot fail to resolve at build time.
  cat > "$OUT/app/src/main/res/values/colors.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="splashBackground">#FF07090B</color>
</resources>
XML
fi

echo "==> Syncing web assets into the project"
# This is the step that copies dist/ into android/app/src/main/assets/public/,
# which is what the app actually loads. Without it the APK bundles an empty
# document and shows a blank screen.
npx cap sync android

echo "==> Verifying the assets made it in"
ASSETS="$OUT/app/src/main/assets/public"
if [ ! -f "$ASSETS/index.html" ]; then
  echo "FAIL: $ASSETS/index.html not found — the APK would bundle an empty page"
  exit 1
fi
echo "    index.html    $(wc -c < "$ASSETS/index.html") bytes"
echo "    total         $(du -sh "$ASSETS" | cut -f1)"
echo "    js bundles    $(find "$ASSETS" -name '*.js' | wc -l)"

# A bundle built for the Pages subpath will 404 every asset inside the APK. The
# check is cheap and catches the single most likely CI misconfiguration.
if grep -qE '(src|href)="/Claude-of-Duty/' "$ASSETS/index.html"; then
  echo "FAIL: the bundle references a Pages subpath. Inside an APK the assets are"
  echo "      served from the root, so BASE_PATH must be '/' when building the game."
  exit 1
fi

echo "==> Android project ready at $GAME_DIR/$OUT"
