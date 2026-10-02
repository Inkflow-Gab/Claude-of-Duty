import { defineConfig } from 'vite';

export default defineConfig({
  /**
   * Public path for the built bundle.
   *
   * This is the one setting that makes a GitHub Pages deploy work or 404, and it
   * fails SILENTLY in the worst way: a wrong base emits absolute `/assets/...`
   * URLs, the page loads, the JS never arrives, and you get a black screen with no
   * error in the console worth reading.
   *
   * The three cases:
   *   - unset locally                 -> '/'  (dev server, and any root deploy)
   *   - set by the Pages workflow     -> '/<repo>/'  (subpath hosting)
   *   - a custom domain / user site   -> set BASE_PATH to '/' explicitly
   *
   * Read from the environment rather than hardcoded so the repo name lives in one
   * place — the workflow — and this file does not have to be edited when the repo
   * is renamed. A trailing slash is required: Vite treats `/repo` and `/repo/`
   * differently and drops the final segment on the latter.
   */
  base: process.env.BASE_PATH || '/',

  // Bind IPv4 explicitly: the default `localhost` binds ::1 only on macOS,
  // which the capture harness (127.0.0.1) cannot reach.
  // `hmr: false` when the capture harness owns the server (OW_NO_HMR=1): a file
  // saved by a concurrently-working agent otherwise reloads the page mid-capture
  // and playwright fails with "Execution context was destroyed".
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    hmr: process.env.OW_NO_HMR ? false : undefined,
  },
  preview: { host: '127.0.0.1' },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 4096 },
  // Large binary game assets served verbatim.
  assetsInclude: ['**/*.ktx2', '**/*.hdr', '**/*.exr', '**/*.bin', '**/*.glb'],
});
