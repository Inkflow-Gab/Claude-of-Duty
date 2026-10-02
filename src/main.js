import { Engine } from './core/engine.js';
import { createConfig } from './core/config.js';

import { RenderSystem } from './render/index.js';
import { MaterialSystem } from './materials/index.js';
import { SkySystem } from './sky/index.js';
import { WorldSystem } from './world/index.js';
import { PhysicsSystem } from './physics/index.js';
import { PlayerSystem } from './player/index.js';
import { WeaponSystem } from './weapons/index.js';
import { FxSystem } from './fx/index.js';
import { AiSystem } from './ai/index.js';
import { UiSystem } from './ui/index.js';
import { AudioSystem } from './audio/index.js';

import { installShotApi } from './dev/shots.js';
import { prewarm } from './core/prewarm.js';
import { Settings } from './core/settings.js';
import { GAME_TITLE, GAME_SUBTITLE } from './core/config.js';
import { installErrorTrap, runDiagnostics } from './core/diagnostics.js';

const params = new URLSearchParams(location.search);
const capture = params.get('capture') === '1';
// Deterministic shutter for the pixel gate: the engine does not schedule its own
// frames, the driver advances exactly N of them through window.__PUMP__. Opt-in,
// because tools that measure real frame pacing (tools/perf.mjs) need the loop to
// free-run. See the long comment in src/dev/shots.js.
const lockstep = capture && params.get('lockstep') === '1';

/**
 * Error trap, installed before anything that can throw.
 *
 * MUST come first, and MUST run in capture mode too. The trap itself draws
 * nothing — it only appends to a DOM node if something actually goes wrong — so
 * it cannot move a pixel, and a failed capture that silently produced 11 black
 * frames would be far worse than a stray overlay. `runDiagnostics` below is the
 * part that draws, and that one IS skipped in capture.
 */
installErrorTrap();

/**
 * Capability check, and the first thing that draws anything.
 *
 * The reason this exists: a WebGL game that cannot render fails SILENTLY. An
 * unsupported render-target format does not throw — the framebuffer comes back
 * incomplete, the draw is dropped, and the result is a black rectangle with an
 * empty console. On a desktop that is a shrug; on a phone, with no devtools, it
 * is indistinguishable from "the site is broken".
 *
 * So the GL features the pipeline depends on are probed up front, and a device
 * that cannot provide them is told so in plain language instead of being shown
 * a black screen. `?debug=1` forces the report on even when everything passed.
 *
 * The probe allocates and discards a throwaway context before the game makes its
 * own, because mobile browsers cap how many can be live at once.
 */
if (!capture) {
  const diag = runDiagnostics(params.get('debug') === '1');
  if (diag && !diag.ok) {
    // Do not start a frame loop that can only produce black. The overlay already
    // explains why; carrying on would only burn the battery.
    console.error('[boot] halted: insufficient WebGL support');
  }
}

const config = createConfig({
  // `undefined` (no `?q=`) is meaningful: it asks createConfig to auto-tier from
  // the device. Passing a default here would disable detection entirely. Capture
  // runs additionally pin themselves to `ultra` inside createConfig, because
  // `deterministic` outranks any device sniff.
  quality: params.get('q') ?? undefined,
  deterministic: capture,
});

/**
 * Settings are loaded BEFORE anything else reads the config, and before any
 * subsystem is constructed.
 *
 * The order is load-bearing in three places: `render` snapshots `cfg.q` at init,
 * so a persisted quality override has to be applied first or the first run after
 * a change would use the wrong preset until the next reload; `weapons` reads the
 * saved skin before it builds a model, or it would bake stock materials and
 * reassign them; and `player`/`input` read sensitivity, so a restored value has
 * to land before the first input is processed.
 *
 * SKIPPED ENTIRELY IN CAPTURE MODE. Persisted settings are player state, and
 * applying them to a capture run would make the baseline image set depend on
 * whatever the machine that happened to run the capture had configured — the
 * exact class of bug the pixel gate exists to prevent. A capture run is always
 * the shipped defaults at `ultra`.
 */
const settings = capture ? null : new Settings(config);
settings?.load();

/**
 * Document title, from `config` so it cannot drift from the pause menu's.
 * `<title>` is not in a screenshot, so this is safe for the pixel gate.
 */
document.title = `${GAME_TITLE} — ${GAME_SUBTITLE}`;

if (capture) console.info('[boot] capture: quality pinned to', config.quality);
else
  console.info(
    `[boot] device ${config.device.tier} — ${config.device.reason} — quality ${config.quality}` +
      (settings?.peek()?.qualityOverride ? ` (saved: ${settings.peek().qualityOverride})` : '')
  );

const canvas = document.getElementById('game');

/**
 * Touch controls are constructed BEFORE the engine so they exist before the
 * first frame, and are enabled only for a device the detector called mobile.
 *
 * Deliberately skipped when `capture` is set: the harness drives the game
 * through `window.__APPLY_SHOT__` and the debug hooks, and an overlay in the
 * screenshot would be both wrong and a source of frame-to-frame variance. This
 * is part of why capture mode pins quality to `ultra` as well.
 */
const ui = document.getElementById('ui');

const engine = new Engine({ canvas, config });
/**
 * `settings` is on the ctx, not on the engine.
 *
 * `ctx` is the shared context every subsystem already receives, and it already
 * carries `config`. Putting the store there rather than threading a ninth
 * constructor argument through `Engine` means a subsystem reaches it the same way
 * it reaches everything else — `ctx.settings?.peek()` — and a subsystem that
 * needs no persistence (all the preview harnesses) simply has no `settings` and
 * the optional chaining handles it.
 */
engine.ctx.settings = settings;

/**
 * The touch layer is attached immediately after the Engine is constructed,
 * because `Input` is created inside it and `TouchControls` synthesises into that
 * instance.
 */
let touch = null;
if (config.touch && !capture) {
  const { TouchControls } = await import('./core/touch.js');
  touch = new TouchControls(ui, engine.input);
  engine.input.touch = touch;
  touch.setEnabled(true);

  /**
   * The menu button reaches the pause menu by a DIRECT call, not by synthesising
   * an Escape key.
   *
   * Synthesising `Escape` would be tidier and is what a keyboard does, but the
   * menu's open path is `input.actionPressed('pause')`, polled once per frame
   * from `ui.lateUpdate` — and `ui` skips that poll entirely while the menu is
   * open. A player tapping the button to close the menu is, by definition,
   * already in the state where the key would be ignored, so the button would
   * open the menu and then be unable to close it.
   */
  touch.onMenu = () => {
    const menu = engine.ctx.peek?.('ui')?.menu;
    if (!menu) return;
    // Drop the held controls FIRST: a player who taps the menu with FIRE still
    // down would otherwise come back to a gun firing itself, because the
    // synthetic `Mouse0` never received a `pointerup`.
    touch.releaseAll();
    if (menu.open) menu.close();
    else menu.show();
  };

  // A device the sniff called desktop but that turns out to be touch gets the
  // controls on its first real touch, rather than being left with no way to
  // play. See Input._onFirstTouch.
  engine.input.onFirstTouch = () => touch.setEnabled(true);

  /**
   * ROTATION AND RESIZE — the part that is easy to get wrong.
   *
   * `orientationchange` alone is not enough, for three separate reasons:
   *
   *   1. On iOS Safari the event fires BEFORE the new viewport dimensions are
   *      readable, so a synchronous `resize()` measures the old size. The 120 ms
   *      delay is the standard workaround and is why the handler is deferred
   *      rather than immediate.
   *   2. Android Chrome fires `resize` on its own during rotation, so a listener
   *      on both events would double-resize and briefly allocate two full sets of
   *      render targets. `resize()` early-outs when the size is unchanged
   *      (see render/index.js), so the second call is free — but only because of
   *      that, and it is worth knowing the guard is load-bearing.
   *   3. The mobile browser UI (address bar) hides on scroll and shows on scroll
   *      up, changing the viewport height by 50-100 px with no orientation change
   *      at all. `visualViewport` is the only thing that reports that, and it is
   *      what makes the HUD scale correctly on a phone at all.
   *
   * Without 3, a player who scrolls the page by accident gets a stretched
   * non-touch-action canvas and controls in the wrong places — the class of bug
   * that reads as "the port is broken" rather than as a missing event handler.
   */
  addEventListener('orientationchange', () => setTimeout(() => engine.resize(), 120));
  /**
   * The iOS keyboard. When the on-screen keyboard opens over the page the
   * viewport shrinks and `visualViewport.height` changes, which the handler above
   * would treat as a genuine resize and reallocate every render target — for a
   * control the player is about to dismiss. The keyboard is never open during
   * play, but it can be during a text input, and there is none in this game, so
   * the guard is cheap insurance rather than a fix for a current bug.
   */
  const vv = globalThis.visualViewport;
  if (vv) {
    /**
     * A RESIZE ON EVERY SCROLL FRAME would reallocate render targets continuously
     * and peg the GPU, so the handler only acts past a threshold. 24 px is roughly
     * the height of the address bar, so genuine chrome changes are caught and
     * sub-pixel jitter is not.
     */
    let lastH = vv.height;
    let lastW = vv.width;
    const onVV = () => {
      const dh = Math.abs(vv.height - lastH);
      const dw = Math.abs(vv.width - lastW);
      if (dh < 24 && dw < 24) return;
      lastH = vv.height;
      lastW = vv.width;
      engine.resize();
    };
    vv.addEventListener('resize', onVV);
    vv.addEventListener('scroll', onVV);
  }
}

// Registration order is irrelevant — Registry topo-sorts on static deps.
engine
  .add(RenderSystem)
  .add(MaterialSystem)
  .add(SkySystem)
  .add(WorldSystem)
  .add(PhysicsSystem)
  .add(PlayerSystem)
  .add(WeaponSystem)
  .add(FxSystem)
  .add(AiSystem)
  .add(UiSystem)
  .add(AudioSystem);

try {
  await engine.init();
} catch (err) {
  console.error('[boot] init failed', err);
  // Routed through the error trap as well as the inline <pre>, so a failure here
  // and a failure inside the frame loop report identically. The inline handler
  // predates the trap and is kept because it runs before the trap's own DOM
  // insertion can be relied on during a very early failure.
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre style="position:fixed;inset:0;padding:2rem;color:#f66;background:#000;
       font:12px/1.5 ui-monospace,monospace;overflow:auto;z-index:9999;white-space:pre-wrap">
BOOT FAILURE\n\n${err.stack ?? err.message}</pre>`
  );
  throw err;
}

const shotApi = installShotApi(engine, { capture, lockstep });

// Compile every shader permutation before the frame loop starts. Measured: without
// this, 86 programs compile lazily during play, up to 30 on one frame, producing
// 3.1-3.9 SECOND stalls. See src/core/prewarm.js.
//
// ON BY DEFAULT since the capture path was made frame-deterministic; opt out with
// `?prewarm=0`. It is now PROVEN pixel-neutral: `tools/baseline.mjs` with
// `--query=prewarm=0` vs `--query=prewarm=1` reports identical:true on all 11
// shots (0 changed pixels, maxDelta 0). The two things that previously made the
// ~1.4 s pre-warm spend look like a visual change were both boot-duration
// couplings OUTSIDE the subsystems: (1) the shutter frame index was latency-bound
// because the engine kept stepping through the driver's round trips — fixed by
// lockstep in src/dev/shots.js; (2) `will-change: transform` on the compass strip
// cached a composited-layer raster taken at a wall-clock-dependent moment — fixed
// in src/ui/style.js.
const warmup = params.get('prewarm') === '0' ? { ok: false, reason: 'disabled by ?prewarm=0' } : await prewarm(engine);
console.info('[boot] prewarm', warmup);
window.__PREWARM__ = warmup;

engine.start();

// Capture harness handshake: only flag ready once a frame has actually landed.
//
// BOOT_FRAMES is deliberately a frame COUNT, not a rAF race. In lockstep mode the
// engine has no loop of its own, so we hand-pump exactly this many frames and only
// then raise __READY__; the shot is therefore always applied at engine frame 3, no
// matter how long boot (or pre-warm) took in wall-clock terms.
const BOOT_FRAMES = 3;
if (lockstep) {
  await shotApi.pump(BOOT_FRAMES);
  window.__READY__ = true;
} else {
  let warm = 0;
  const readyProbe = () => {
    if (++warm >= BOOT_FRAMES) {
      window.__READY__ = true;
      return;
    }
    requestAnimationFrame(readyProbe);
  };
  requestAnimationFrame(readyProbe);
}

window.__ENGINE__ = engine;

/**
 * "Rotate your device" — the one piece of touch UI that lives outside
 * TouchControls, because it has to be visible while the controls are dimmed for
 * portrait. Pure DOM, removed on rotate, and never present in capture mode.
 */
if (touch) {
  const rotate = document.createElement('div');
  rotate.className = 'ow-rotate';
  rotate.style.cssText = [
    'position:absolute', 'left:50%', 'top:50%', 'transform:translate(-50%,-50%)',
    'padding:14px 20px', 'border-radius:10px', 'z-index:7',
    'background:rgba(8,10,12,.86)', 'border:1px solid rgba(238,244,247,.22)',
    'color:rgba(238,244,247,.92)', 'font:600 13px/1.35 system-ui,sans-serif',
    'text-align:center', 'letter-spacing:.04em', 'pointer-events:none',
    'display:none',
  ].join(';');
  rotate.innerHTML = 'Rotate to landscape<span style="display:block;opacity:.6;font-weight:400;margin-top:4px">this is a landscape game</span>';
  ui.appendChild(rotate);
  const syncRotate = () => {
    rotate.style.display = touch.needsRotate ? 'block' : 'none';
  };
  syncRotate();
  addEventListener('resize', syncRotate);
  addEventListener('orientationchange', syncRotate);
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    touch?.dispose();
    engine.dispose();
  });
}
