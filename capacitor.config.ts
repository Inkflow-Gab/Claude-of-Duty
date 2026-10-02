import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor config for the Android wrapper.
 *
 * `webDir` is the Vite build output. Capacitor copies that directory into the
 * Android project and the app loads it from the APK's own storage, which is the
 * entire performance argument for wrapping: no 1.6 MB round trip to GitHub on
 * every launch, and no network at all once installed.
 *
 * `server.androidScheme` must be `https` even though nothing is fetched over the
 * network. Capacitor serves local assets through a synthetic origin, and the
 * WebView will refuse `localStorage`, `getContext('webgl2')` secure-context
 * requirements and service workers under `http://`. This is a known Capacitor
 * wart and the scheme is the fix — it does NOT mean the app talks to a server.
 */
const config: CapacitorConfig = {
  appId: 'com.blackofduty.game',
  appName: 'Black of Duty',
  webDir: 'dist',
  android: {
    // Serve bundled assets from an https-scheme synthetic origin. See above.
    allowMixedContent: false,
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
