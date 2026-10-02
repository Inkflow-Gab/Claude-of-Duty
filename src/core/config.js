/**
 * Central tuning + quality configuration.
 * Subsystems read from here rather than hardcoding magic numbers, so the
 * quality scaler and the capture harness can drive everything from one place.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * HOW A NEW PRESET HAS TO BE WIRED IN — four places, and missing any one of them
 * fails silently in the expensive direction.
 *
 *   1. `QUALITY_PRESETS` below. Must set EVERY key, not just the ones that
 *      differ: `setQuality` does `Object.assign(cfg.q, PRESETS[name])`, so a key
 *      absent here is not cleared but INHERITED from the preset that was active
 *      before. Switching from `ultra` to a new tier that omits `density` would
 *      leave the desktop density in place and the tier would do nothing to the
 *      geometry.
 *   2. `QUALITY_LEVEL` in src/render/index.js. The lookup falls back to 3, which
 *      is `ultra` — so an unlisted name silently gets the 16/20 PCSS tap counts,
 *      a 6-mip bloom pyramid and 4x viewmodel MSAA. The most expensive
 *      configuration on the ladder, not the cheapest.
 *   3. `PRESETS` in src/ui/menu.js, or the preset is unreachable from the menu.
 *   4. Nothing else. The tiering is otherwise fully data-driven.
 *
 * Two places used to string-compare the preset name and would have silently
 * ignored any new tier — `materials` (texture bake scale) and `sky` (volumetric
 * step count). Both now read a real key from the preset instead, precisely so
 * that step 1 above is the complete list.
 */

/**
 * The game's name, in one place.
 *
 * "OVERWATCH" was the working title of the original brief and survives in a
 * handful of code comments and the engine-contract heading, but it is a
 * pre-existing trademark and it is not this project's name. Anything the PLAYER
 * sees comes from here.
 */
export const GAME_TITLE = 'BLACK OF DUTY';
export const GAME_SUBTITLE = 'TACTICAL OPERATIONS';

export const PHYSICS_HZ = 120;
export const FIXED_DT = 1 / PHYSICS_HZ;
/** Never simulate more than this many physics steps in one frame (spiral-of-death guard). */
export const MAX_SUBSTEPS = 8;

/** Real-world units are metres, seconds, kilograms. */
export const UNITS = {
  gravity: -9.81 * 2.1, // Games use exaggerated gravity; CoD-like feel.
  playerHeight: 1.78,
  playerCrouchHeight: 1.12,
  playerRadius: 0.32,
  eyeOffset: 0.12, // below top of capsule
};

export const QUALITY_PRESETS = {
  low: {
    renderScale: 0.72,
    shadowMapSize: 1024,
    cascades: 3,
    shadowDistance: 60,
    taa: false,
    gtao: false,
    ssr: false,
    volumetrics: false,
    motionBlur: false,
    bloom: true,
    anisotropy: 4,
    particleBudget: 2000,
    decalBudget: 64,
    density: 1,
    textureScale: 0.5,
    pixelRatioCap: 1.5,
    viewSamples: 0,
  },
  /**
   * PHONE / TABLET. The aggressive end of the ladder, and deliberately not just
   * "low with a smaller buffer" — see the note on `density` below.
   *
   * The post chain is the cheap half of the problem. The expensive half is that
   * every world draw call is submitted once per shadow cascade plus once for the
   * prepass, so 3 cascades already means 5x the geometry work of a single pass,
   * and the level is authored at ~11.3 M triangles. Cutting cascades 4 -> 3 is
   * therefore worth ~17% of ALL triangle throughput for free, and renderScale
   * 0.55 at a 1.0 pixel-ratio cap means a 1080x2340 phone renders the world at
   * ~594x1287 instead of 1620x3510 — a 2.7x fill-rate cut before any effect is
   * disabled.
   */
  mobile: {
    renderScale: 0.55,
    shadowMapSize: 1024,
    cascades: 3,
    shadowDistance: 70,
    // No TAA, GTAO, SSR, volumetrics or motion blur. Each is a multi-pass,
    // full-resolution effect and every one of them is a separate draw over the
    // whole frame; FXAA replaces TAA because at 0.55 scale a 4x MSAA viewmodel
    // target costs more memory than it is worth.
    taa: false,
    gtao: false,
    ssr: false,
    volumetrics: false,
    motionBlur: false,
    bloom: true,
    anisotropy: 4,
    particleBudget: 1200,
    decalBudget: 48,
    /**
     * World geometry density multiplier, consumed by src/world. There was NO
     * density knob in the world at all before this — every scatter count was a
     * hard-coded literal — so this is the single biggest lever available for
     * triangle count and it has to exist before `mobile` means anything.
     */
    density: 0.4,
    /**
     * Procedural texture bake scale. `materials` used to infer this by
     * string-comparing the preset name, which meant any new tier silently got
     * full-resolution bakes. 0.5 is the same budget `low` already ships.
     */
    textureScale: 0.5,
    /**
     * Ceiling applied to `devicePixelRatio` when sizing the drawing buffer.
     * The renderer hard-codes 1.5; a phone reporting DPR 3 would otherwise
     * multiply the internal resolution by 2 on top of `renderScale`.
     */
    pixelRatioCap: 1.0,
    /** MSAA samples on the viewmodel target. 0 = none (see _viewSamples). */
    viewSamples: 0,
  },
  medium: {
    renderScale: 0.85,
    shadowMapSize: 2048,
    cascades: 3,
    shadowDistance: 90,
    taa: true,
    gtao: true,
    ssr: false,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 8,
    particleBudget: 6000,
    decalBudget: 128,
    density: 1,
    textureScale: 0.75,
    pixelRatioCap: 1.5,
    viewSamples: 2,
  },
  high: {
    renderScale: 1.0,
    shadowMapSize: 2048,
    cascades: 4,
    shadowDistance: 140,
    taa: true,
    gtao: true,
    ssr: true,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 16,
    particleBudget: 12000,
    decalBudget: 256,
    density: 1,
    textureScale: 1,
    pixelRatioCap: 1.5,
    viewSamples: 4,
  },
  ultra: {
    renderScale: 1.0,
    shadowMapSize: 4096,
    cascades: 4,
    shadowDistance: 200,
    taa: true,
    gtao: true,
    ssr: true,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 16,
    particleBudget: 24000,
    decalBudget: 512,
    density: 1,
    textureScale: 1,
    pixelRatioCap: 1.5,
    viewSamples: 4,
  },
};

export const DEFAULTS = {
  quality: 'ultra',
  fov: 80, // horizontal-ish vertical FOV, CoD default feel
  adsFovScale: 0.72,
  sensitivity: 0.0022,
  adsSensScale: 0.65,
  invertY: false,
  exposure: 1.0,
  /** Master volume, 0..1. Read by `audio`; persisted by `core/settings.js`. */
  masterVolume: 0.8,
  /**
   * True once the player has explicitly chosen a preset. Set by
   * `core/settings.js` from storage, and by the menu. It does NOT change which
   * preset is active — it records that the choice was deliberate, so the boot
   * auto-tier will not override it on the next run.
   */
  qualityPinned: false,
  /** Capture mode disables anything nondeterministic so screenshots are stable. */
  deterministic: false,
};

/**
 * Which ladder rung to start on, decided from the device rather than from a URL
 * parameter.
 *
 * WHAT IS AND IS NOT CHECKED. The expensive discriminators are deliberately not
 * used: there is no GPU-string matching and no benchmark. A user-agent sniff
 * misclassifies precisely the devices that matter (iPadOS reports a Mac
 * UA; Chrome on Android claims to be a desktop), and a micro-benchmark at boot
 * costs more than it saves. The three signals below are the ones that are both
 * cheap and stable across the population that actually matters:
 *
 *   maxTouchPoints  the only reliable touch signal there is. A touchscreen
 *                   laptop or a Windows tablet gets the touch path and still
 *                   gets desktop effects, which is correct.
 *   coarse pointer   `matchMedia('(pointer: coarse)')` is true exactly when the
 *                   primary input cannot hover, i.e. a finger.
 *   hardwareConcurrency / deviceMemory
 *                   core count and the UA-CH memory hint. Both are absent on
 *                   older Safari, hence the `??` fallbacks, and both are coarse
 *                   on purpose — they only ever split "clearly a phone" from
 *                   "clearly not".
 *
 * A low core count alone is NOT treated as mobile: a 4-core desktop is common
 * and would be pushed to a 0.55 render scale it does not need. The gate is
 * "is the primary input a finger", with core count only able to veto UP into
 * mobile on a device that already looks like a phone.
 *
 * @returns {{ tier: 'mobile'|'desktop', reason: string, touch: boolean }}
 */
export function detectDevice() {
  if (typeof navigator === 'undefined') {
    return { tier: 'desktop', reason: 'no navigator (headless/SSR)', touch: false };
  }
  const cores = navigator.hardwareConcurrency ?? 0;
  const mem = navigator.deviceMemory ?? 0;
  const touchPoints = navigator.maxTouchPoints ?? 0;
  const coarse =
    typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)').matches : false;

  // A finger is the signal that matters; it is also what enables the touch
  // controls, so tier and input scheme always agree.
  if (coarse && touchPoints > 0) {
    // A very weak phone still gets `mobile` — there is nothing cheaper on the
    // ladder, and `density` is already the floor for the geometry work.
    return {
      tier: 'mobile',
      reason: `touch primary pointer (${touchPoints} points, ${cores || '?'} cores, ${mem || '?'} GB)`,
      touch: true,
    };
  }
  return {
    tier: 'desktop',
    reason: `${cores || '?'} cores, ${mem || '?'} GB, ${touchPoints} touch points`,
    touch: false,
  };
}

export function createConfig(overrides = {}) {
  const cfg = { ...DEFAULTS, ...overrides };

  // Always record what the device looks like, so the UI can offer the right
  // suggestion and the debug overlay can report it. Never act on it here.
  cfg.device = detectDevice();
  cfg.touch = cfg.device.touch;

  /**
   * Auto-tier ONLY when the caller did not name a preset explicitly.
   *
   * `overrides.quality` is read directly rather than `cfg.quality`, because
   * DEFAULTS supplies 'ultra' and a defaulted value is indistinguishable from
   * an explicit one after the spread — which would silently re-tier a run that
   * had deliberately asked for `ultra`.
   *
   * `deterministic` outranks everything. The capture harness passes it and its
   * entire job is bit-reproducibility, so a device sniff that quietly dropped
   * the run to `mobile` would invalidate the baseline image set that every
   * optimisation is judged against. A device sniff must never be able to change
   * what the pixel gate photographs.
   */
  if (overrides.quality) {
    cfg.quality = overrides.quality;
  } else if (cfg.deterministic) {
    cfg.quality = 'ultra';
  } else {
    cfg.quality = cfg.device.tier === 'mobile' ? 'mobile' : 'ultra';
  }

  cfg.q = { ...QUALITY_PRESETS[cfg.quality] };
  cfg.setQuality = (name) => {
    if (!QUALITY_PRESETS[name]) throw new Error(`unknown quality preset "${name}"`);
    cfg.quality = name;
    Object.assign(cfg.q, QUALITY_PRESETS[name]);
  };
  /**
   * Player-facing name of the game.
   *
   * Lives here rather than being hardcoded in `ui` and `index.html` because
   * there are three places that show it — the document title, the pause menu
   * subtitle, and the demo reel's title card — and they have to agree. A literal
   * duplicated three times is how a rename ends up half-applied.
   */
  cfg.title = GAME_TITLE;
  cfg.subtitle = GAME_SUBTITLE;
  return cfg;
}
