# AGENTS.md — Claude of Duty

Browser FPS: WebGL2 + Three.js r180, ~65k lines across 11 subsystems. **Zero art
assets** — every texture, mesh, animation and sound is generated in code at boot.
`three` is the only runtime dependency.

Read `ARCHITECTURE.md` before touching code. It is the subsystem interface, the
ownership map, the event vocabulary and the quality bar. This file only covers
what it does not.

## Setup

```bash
npm install
npx playwright install chromium   # separate step; every tool under tools/ needs it
npm run dev                       # http://127.0.0.1:5173
```

**Deploying:** `.github/workflows/deploy.yml` publishes to GitHub Pages on every
push to `main`. It is a static site — no backend. `BASE_PATH` must be
`/<repo>/` (the workflow sets it) or every asset 404s and you get a black screen;
that is set in `vite.config.js` from the environment, so do not hardcode a path
there. The build has **never been run on real hardware** — see the caveat below.

**The sandbox caveat, if `npm run build` or `npm run dev` fails here:** rollup's
native binding cannot be `dlopen`ed under this Android sandbox, and an esbuild
binary copied to `/mnt/sdcard` cannot be exec'd. Neither is a code problem. Use
esbuild to check syntax instead (`node_modules/.bin/esbuild src/main.js --bundle
--format=esm --outfile=/dev/null`), which catches parse and import errors but is
**not** a substitute for the real build.

There is no lint, no formatter and no typecheck. `npm run build` (vite) is the
only automated check that catches syntax errors, and `src/verify.mjs` covers the
logic a browser cannot. Everything visual is verified by looking at pixels.

## Architecture that isn't obvious from filenames

- `src/main.js` registers the 11 systems; `Registry.resolve()` topo-sorts on each
  class's `static deps`, so **registration order in `main.js` is irrelevant**.
- **Never import another subsystem's module** — always `ctx.get('fx')` /
  `ctx.peek('fx')` / `ctx.has('fx')`. This single rule is what keeps subsystems
  editable in isolation, and it is the rule most easily broken by accident.
- Frame order (`src/core/engine.js`): `input.beginFrame()` → `fixedUpdate(1/120)`
  ×N (max 8, backlog is shed not accumulated) → `update(dt)` → `lateUpdate(dt)` →
  `render` → `input.endFrame()`.
- `viewScene` / `viewCamera` are a **separate scene** for the first-person
  weapon, composited after the world with a cleared depth buffer so the weapon
  can never clip through geometry. It has its own light rig.
- `src/*/preview.{html,js}` boot **one subsystem standalone** against a minimal
  stand-in renderer. Far faster to iterate on than the full game, and they do not
  ship: `/src/materials/preview.html?view=board|wall|street|closeup|grazing&m=concrete,brick`,
  `/src/weapons/preview.html?w=rifle&view=hero|side|hands|ads|...`,
  `/src/fx/preview.html?kind=wall|...`, `/src/ai/preview.html?variant=vanguard&view=front|...`.

## Rules that break silently

- **No `Math.random()` in gameplay or visuals** — use `ctx.rng` or a
  `ctx.rng.fork()` you own. Capture reproducibility depends on it.
- **No `performance.now()` / `Date.now()` driving anything visual.** Use
  `ctx.time` (`elapsed`, `raw`, `dt`, `alpha`, `frame`). If output depends on
  wall clock, changing boot duration or frame pacing changes the rendered image,
  which makes every optimization unverifiable. (Instrumentation that only logs
  timings is fine.)
- **Allocate nothing per frame.** Preallocate vectors/matrices/arrays in `init()`.
- Free geometries, materials, textures and render targets in `dispose()`.
- No new npm dependencies, no CDN fetches, no external image/audio/model files.

## Verification: the pixel gate

`tools/baseline.mjs` + `tools/imagediff.mjs` is the real test suite.

```bash
OW_NO_HMR=1 node tools/baseline.mjs --out=/tmp/before --port=5320
# ... make the change ...
OW_NO_HMR=1 node tools/baseline.mjs --out=/tmp/after  --port=5320
node tools/imagediff.mjs --a=/tmp/before --b=/tmp/after   # must be identical: true
```

- Must report `identical: true`. "withinEpsilon" / "close enough" is a **failed**
  gate. `imagediff.mjs` exits non-zero unless clean. Add `--write-diff` to get
  changed pixels in magenta, and `--shots=hero,night` to narrow the set.
- **Use `baseline.mjs`, never `shotset.mjs`, for anything you will diff.**
  `shotset.mjs` reuses one page across all 11 shots, so particle age, decal ring
  buffer and auto-exposure state leak forward and ~10 of 11 shots differ between
  two identical runs. It is the fast human review set only.
- The 11 shots are defined in `src/dev/shots.js`: `hero interior detail sunset
  night weapon ads muzzle combat impacts hud`.
- `OW_NO_HMR=1` is not optional for capture runs. A file saved mid-run triggers
  an HMR page reload and playwright fails with "Execution context was destroyed".
- **Determinism self-test** — if output must be independent of boot duration:
  `--query=prewarm=0` vs `--query=prewarm=1` must also be identical.
- Trap: `baseline.mjs` calls `render.resetTemporal?.() ?? render.resetHistory?.()
  ?? render.invalidateHistory?.()`. **None of those methods exist**, so the
  "temporal reset" step is currently a silent no-op — determinism rests entirely
  on lockstep frame pumping. If you add a method with any of those names to
  `RenderSystem`, baseline starts calling it and every capture shifts.
- Trap: `npm run shot` with no args uses shot name `default`, which does not
  exist. Always `npm run shot -- --shot=hero --out=/tmp/hero.png`.

## Ports

`vite.config.js` uses `strictPort`, so concurrent runs collide. Assign each agent
its own port (the scheme in `tools/workflows/perf.js` is `5300 + n`).

| tool | server |
|---|---|
| `capture.mjs`, `shotset.mjs`, `baseline.mjs` | auto-start vite on 5173 |
| `demo.mjs` | auto-start vite on 5178 (also needs **system `ffmpeg`**) |
| `probe.mjs` | auto-start vite on 5402 |
| `profile.mjs` | **needs one already running**, default 8080 |
| `perf.mjs`, `playtest.mjs` | **hardcoded** 8080 — start `npx vite --port 8080` yourself |
| `dbgview.mjs` | **hardcoded** 5402 |

So `node tools/playtest.mjs` fails with a connection error unless you already have
a server on 8080.

## Headless checks

Run without a browser (`npm install` first):

```bash
node src/verify.mjs            # mobile tier, device detection, settings, skins, shotgun ammo. 238 checks
node src/physics/selftest.js   # BVH/raycast/capsule/ragdoll; real pass/fail, exits 1 on failure
node src/ai/selftest.mjs       # soldier geometry sanity + albedo/contrast budget
```

`src/verify.mjs` is the one to run after touching `core/config.js`, `core/touch.js`,
`core/settings.js`, `weapons/skins.js`, `weapons/skinfx.js` or the shotgun. It
asserts the things a screenshot cannot: that every preset defines every key, that
a device sniff can never change what the capture path photographs, that hostile
storage cannot break boot, and that the density gate is deterministic.

It also reads a few files as **text** (`src/__probe_sources.mjs`) to assert
architectural rules that no behavioural test can catch — that the kill flare uses
the pooled light and never toggles `light.visible`, that the skin effect reads
`ctx.time` and not `performance.now()`. Those assertions strip comments first,
since the files document *why* the banned pattern is banned and a raw grep
matches the prose. If one starts failing for an unrelated reason, fix the code or
delete the assertion — do not loosen the pattern until it passes.

The two `selftest` files include **wall-clock assertions** (`build under 400 ms`,
`rigid body step is cheap`) that fail on a slow or thermally-throttled machine
regardless of correctness — read the numeric detail before believing one.

Browser-driven: `node src/audio/probe.mjs` (runs `src/audio/selftest.js` in an
`OfflineAudioContext`), `node src/player/feeltest.mjs` (movement metrics),
`node src/ai/bootframes.mjs` (first-N-frame stalls the profiler discards),
`node tools/profile.mjs --port=<p> --dpr=2 --frames=900` (frame-time
*distribution* + per-frame WebGL program deltas — a median frame time hides the
stalls that make the game feel broken, so read p99 and `worstHitches`).

Per-subsystem probes: `src/{ai,audio,world,ui,materials,fx,weapons}/` each ship a
`shoot.mjs` or `probe.mjs` mirroring `tools/capture.mjs`. Screenshot the
standalone preview pages with them.

## Mobile, touch, and settings

- **The settings menu was unreachable on mobile before the `≡` button existed.**
  It only opened on `Escape` (no such key) or pointer-lock loss (never on touch).
  The button is a **latch**, not a held key, and it calls `menu.show()/close()`
  *directly* — synthesising `Escape` cannot work, because `ui.lateUpdate` skips
  the pause poll entirely while the menu is open, so the button could open the
  menu and never close it.
- **`PauseMenu.close()` must stay gated on `!this.touch`.** Requesting pointer
  lock on a touch device is a no-op at best and an unhandled `SecurityError` at
  worst.
- **Pausing must call `input.touch.releaseAll()`.** A fire button held by its
  pointer never gets a `pointerup`, so without this a player who pauses with FIRE
  down returns to a gun firing itself.
- **The touch menu is a different layout, not a smaller one.** `.ow-menu-touch`
  in `style.js` goes full-width, scrolls, and enforces 44 px targets. The desktop
  column is 430 px in a viewport assumed tall — on a landscape phone (~400 px
  tall) it overflowed off both ends with no way to reach the content.
- **Rotation is three events, not one.** `orientationchange` fires before iOS has
  readable dimensions (hence the 120 ms deferral), Android fires `resize` on its
  own (the second call is free only because `render.resize()` early-outs), and
  `visualViewport` is the only thing that reports the address bar hiding. The
  24 px threshold on the `visualViewport` handler is load-bearing — without it,
  scrolling reallocates render targets every frame.
- **Settings live in `core/settings.js` and are observed, not remembered.** The
  menu still calls `config.setQuality`; the store watches. A control that forgets
  to save is a control that loses the player's choice.
- **Not persisted, deliberately:** quality (re-derived per device — but an
  explicit `qualityOverride` *is* honoured), touch, and FOV. FOV is per-screen; a
  value carried from a monitor to a phone is worse than re-deriving it.
- **`Settings` is skipped entirely in capture mode.** Persisted player state
  applied to a capture run would make the baseline depend on whatever the machine
  that ran the capture had configured.
- **`reset()` must clear storage, not just live values** — otherwise "Defaults"
  looks correct until the next reload.
- Auto-tiering is opt-out via `?q=`. No `?q=` means `createConfig` picks
  `mobile` for a touch device and `ultra` otherwise. `capture=1` sets
  `deterministic`, which pins the preset to `ultra` unconditionally — a device
  sniff must never be able to change what the pixel gate photographs.
- **Adding a quality preset requires FOUR edits**, or it fails silently in the
  expensive direction: `QUALITY_PRESETS` in `core/config.js` (every key —
  `setQuality` uses `Object.assign`, so a missing key is *inherited* from the
  previous tier, not cleared), `QUALITY_LEVEL` in `render/index.js` (its `?? 3`
  fallback is `ultra`), and `PRESETS` in `ui/menu.js`. The list is documented at
  the top of `core/config.js`.
- `touch.js` synthesises the **same key codes a keyboard would** into
  `Input._pendingDown`/`_rawLook`. There is no `input.isTouch` and no second
  control path in `weapons` or `player` — do not add one. The stick snaps to the
  eight compass directions so `moveVector` and the sprint thresholds behave
  identically to WASD.
- The world had **no density knob** before the mobile tier. `Assembler.d(n)`
  scales scatter counts and `proto(..., { scatter: true })` gates decorative
  instances via an accumulator. `scatter` is only for props whose absence is
  invisible — **never for cover**, or the fights change.
- `world._stabiliseLightCount` is not optional on mobile. `LIGHT_SLOTS = 20` and
  `_lightTarget` ratchets *up* only, so the visible point-light count must stay
  constant: reduce a light's `range` or `intensity`, never its count.

## Kill and death attribution

- `physics` is the **only** system that can attribute a hit, because it is the
  one that traced the round. It stamps `by: 'player'` on `damage:dealt`; `ai`
  forwards it through `applyDamage` → `die` → the `actor:death` payload.
- **The literal string `'player'` is the contract**, not the subsystem instance —
  `ui._isPlayerTarget` and `fx`'s kill gate both test for it, which is what keeps
  the killfeed, the hitmarker and the kill flare from disagreeing.
- The kill flare goes through `this.lights.flash(...)` (the pooled system), which
  keeps lights at `visible: true` and zero intensity. **Do not make a kill
  effect toggle `light.visible`** — that is a shader permutation key change
  costing +33-36 programs and 640-900 ms.
- `actor:death` also fires for AI-on-AI deaths and for the player's own death.
  Anything player-specific must be gated on `by`, never on "a death happened".

## Weapons, skins, and the shotgun

- A **skin is a material remap, not a texture** — there are no image files. See
  the long note at the top of `weapons/skins.js` and the one above
  `WEAPON_MATERIALS` in `weapons/materials.js`.
- **Two skins carry a LIVE effect** (`reactive`, `gold`): a thin-film
  `iridescenceThicknessRange` sweep plus a scrolling additive band. They are
  driven from `ctx.time`, never `performance.now()` — a wall clock there would
  break the pixel gate for *every* shot, not just skinned ones.
- three does not expose film thickness as a scalar; the sweep moves the **range**,
  and `SkinFilm` captures each material's authored range on first attach so the
  oscillation cannot compound frame over frame.
- A skin swap must call `setSkinEffect`, not just `applySkin` — otherwise a boot
  that lands directly on `reactive` shows a static version until the menu is
  touched.
- **Weapon albedos are deliberately crushed to ~1/3 of physical.** The viewmodel
  light rig delivers ~20x the world irradiance per unit albedo. A skin with a
  physically-plausible albedo renders as a white blob. This is the easiest way to
  break a skin and no unit test catches it — only a screenshot does.
- `MeshStandardMaterial` hard-codes `specularF90 = 1.0`, so a light-finish optic
  in ADS needs a *tighter* grazing clamp than a black one, not a looser one.
- **Adding a weapon** = a def in `defs.js` + a builder in `models/` + a row in
  the `builders` table in `weapons/index.js`. The builder table *is* the weapon
  list, and `Digit1..9` binds by position from it. `debugPose` always poses the
  **rifle**, on purpose: the `weapon`/`ads`/`muzzle` shots are the pixel-gate
  baseline and must not change.
- A skin swap is a material reassignment on existing meshes, so it needs
  `prewarmMaterials` to have compiled every variant — that is why `weapons`
  implements the hook. A skin change mid-fight is instant and resets no ammo.
- The shotgun's three genuinely different mechanics, all data-driven: `pellets`
  (one sim entry per pellet, centre one carries the tracer), `tubeCapacity` with
  `magSize: 1` (chamber first, then tube; **never debit reserve for a shell with
  nowhere to go**), and `pumpTime` (blocks firing until the fore-end cycles, and
  a pump is *not* a reload — the HUD must not show a progress bar for it).

## Engine constraints worth knowing before you break the frame

- **Visible point-light count is a shader permutation key.** Three bakes it into
  every material's program cache key, so one distance-culled lamp toggling
  `visible` recompiles every lit material in the scene (+33–36 programs,
  640–900 ms on that one frame). Keep the count constant: drive `intensity` to 0
  instead of `visible = false` (`src/fx/lights.js`), or ballast the count in
  `lateUpdate` (`world._stabiliseLightCount`). A colour×intensity of exactly 0
  adds `0.0` to the irradiance accumulator, so extra slots cannot move a pixel.
- **`mesh.castShadow` is ignored.** The CSM cascades draw with
  `scene.overrideMaterial` and never consult it. The only switches are
  `userData.owNoShadow` and `userData.owNoPrepass`.
- **Shader pre-warm (`src/core/prewarm.js`) is on by default** (`?prewarm=0`
  disables) and is proven pixel-neutral. It exists because lazily-compiling
  programs caused 3–4 second stalls. It snapshots and restores `engine.time`,
  the `Rng` state and `_accum` — keep it simulation-transparent. `fx` is excluded
  and self-warms on frame 2; do not "helpfully" drive it from core, that latches
  its `_warmed` flag and pushes 12 programs back onto the first shot fired.
- A **render target must be bound while compiling**: `outputColorSpace` and
  `toneMapping` are in the cache key and are read off the *currently bound*
  target. Compiling with the canvas bound warms a variant nothing draws.
- `render` patches lit materials with CSM/AO/SSR via `onBeforeCompile` before
  `prewarmMaterials()` runs, for that reason. A program compiled off an unpatched
  material is discarded by the first real frame.
- **The optional per-subsystem hook is `prewarmMaterials(ctx)`**: build and compile
  every material the subsystem can produce, *without* spawning gameplay objects,
  drawing a gameplay frame, or touching the clock or RNG. Implemented by `render`,
  `world`, `ai`. If you add a new material family, implement it there or expect
  first-use shader stalls.
- `ctx.events` is synchronous and swallows handler exceptions (logs and
  continues). `damage:dealt` means damage dealt *to* `target` — filter out hits on
  the local player before drawing a hitmarker; the target applies its own damage.

## Capture harness contract

`src/dev/shots.js` + `src/main.js` expose, on `window`:
`__READY__`, `__ENGINE__`, `__SHOTS__`, `__APPLY_SHOT__(name, {grabFrame})`,
`__PUMP__(n)`, `__PRESENT__(n)`, `__RENDER_INFO__`, `__PREWARM__`, `__LOCKSTEP__`.

`?capture=1` freezes input and forces an exact 1/60 dt. `?lockstep=1` (requires
`capture=1`) stops the engine from ever scheduling its own frames — the harness
pumps them — which is the only reason captures are bit-reproducible. Tools that
measure real frame pacing (`tools/perf.mjs`, `profile.mjs`) must therefore run
*without* `lockstep`. `?q=low|medium|high|ultra` (default `ultra`).
`?rview=ao|normal|velocity|depth|ssr|ssrmask|contact|bloom|view|viewalpha`
selects a render debug view. `?shot=<name>` is **not** read by the app — the
harness applies shots through `__APPLY_SHOT__`.

Debug hooks used by the harness (keep them working): `weapons.debugPose`,
`fx.debugBurst`, `ai.debugStage`, `ui.debugState`, `physics.debugState`,
`player.setControlEnabled`, `player.teleport`, `sky.setTimeOfDay`.

## Known unfixed

The viewmodel light rig in `src/render/index.js` delivers ~20× the world
irradiance per unit albedo (a black material renders at L=110 against a
background of 91), so every weapon albedo is cheated to a third of physical to
compensate. This caps material separation on the most-looked-at object in the
game. It is diagnosed in `README.md` but unfixed — don't re-derive it.
