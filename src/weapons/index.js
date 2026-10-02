import * as THREE from 'three';
import { Rng } from '../core/rng.js';
import { WeaponMaterials, ENV_OCCLUSION } from './materials.js';
import { Viewmodel } from './viewmodel.js';
import { ProjectileSim } from './ballistics.js';
import { WEAPON_DEFS, buildRecoilPattern, SPREAD_MODS } from './defs.js';
import { SKINS, SKIN_IDS, resolveSkin } from './skins.js';
import { buildRifle } from './models/rifle.js';
import { buildSmg } from './models/smg.js';
import { buildPistol } from './models/pistol.js';
import { buildShotgun } from './models/shotgun.js';
import { clamp, clamp01, lerp, damp, DEG } from './mathx.js';

/**
 * WEAPONS — weapon meshes, the first-person viewmodel rig, ADS, recoil, sway,
 * bob, reload/inspect animation and projectile ballistics.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT LIVES HERE
 *   geometry.js   hard-surface kit: chamfered boxes, lathes, extrusions,
 *                 Picatinny rail, M-LOK, knurling, screws, and the Assembly
 *                 that merges everything down to a handful of draw calls.
 *   parts.js      real firearm components built from published dimensions:
 *                 receivers, barrels, muzzle devices, handguards, stocks,
 *                 grips, magazines, optics, iron sights, triggers.
 *   models/*.js   the three weapons assembled from those parts.
 *   hands.js      gloved hands + sleeved arms, two-bone IK from the hand.
 *   viewmodel.js  the animation stack (sway/bob/lag/recoil/ADS/clips).
 *   clips.js      keyframed reload / inspect / draw timelines.
 *   ballistics.js travelling projectiles with gravity and drag.
 *   defs.js       every tuning number, plus the deterministic recoil patterns.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * PUBLIC API — `const wp = ctx.get('weapons')`
 * ────────────────────────────────────────────────────────────────────────────
 *   wp.current            { id, label, class, mode, magSize, ... } (the def)
 *   wp.ammo               { mag, chambered, reserve, magSize, total, empty }
 *   wp.fireMode           'auto' | 'burst' | 'semi'
 *   wp.spreadDegrees      live cone half-angle — drive the crosshair gap with it
 *   wp.adsProgress        0..1
 *   wp.reloading / wp.firing / wp.switching / wp.inspecting
 *   wp.weaponIds          ['rifle','smg','pistol']
 *   wp.setWeapon(id)      draw/holster animated swap
 *   wp.nextWeapon()
 *   wp.cycleFireMode()
 *   wp.reload()           no-op if full or empty of reserve
 *   wp.inspect()
 *   wp.tryFire()          honours fire mode + rpm; returns true if a shot left
 *   wp.viewmodel          the rig (fx/ui may read muzzle/eject transforms)
 *   wp.muzzleWorld(v3)    world-space muzzle, for anything that needs it
 *   wp.debugPose(kind)    'idle' | 'ads' | 'fire'  (the capture harness)
 *   wp.stats              { tris, drawCalls, live, fired }
 *
 * EVENTS EMITTED  (all canonical, see ARCHITECTURE.md)
 *   weapon:fire    { weapon, origin, dir, seed }
 *   weapon:shell   { position, velocity }
 *   weapon:reload  { weapon, phase: 'start'|'magout'|'magin'|'end' }
 *   bullet:tracer  { from, to, speed }
 * `bullet:impact` comes from physics, because physics owns penetration.
 * Anything else (ammo counts, fire mode, the current weapon) is a getter on
 * this object rather than an event, so no new event types are introduced.
 */
export class WeaponSystem {
  static id = 'weapons';
  static deps = ['materials', 'physics'];

  constructor() {
    this.viewmodel = null;
    this.sim = null;
    this.states = new Map();
    this.activeId = 'rifle';
    this.debugMode = null;
    /** Active skin id. Read from `?skin=` at boot, settable at runtime. */
    this.skin = 'issue';

    this._fireTimer = 0;
    this._burstLeft = 0;
    this._burstCooldown = 0;
    this._semiLatch = false;
    this._spread = 0;
    this._shotIndex = 0;
    this._sinceShot = 10;
    this._switchTimer = 0;
    this._switchTo = null;
    this._reloadPhase = null;

    this._muzzle = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._camDir = new THREE.Vector3();
    /**
     * Pellet shot, preallocated. Nine is the cap the shotgun def declares;
     * `tryFire` clamps to this length so a def asking for more cannot overrun it.
     *
     * Three parallel arrays because a shotgun's nine projectiles have to share
     * one origin and one damage figure but differ in direction: a single mutable
     * payload would have to be rebuilt nine times per trigger pull, which is
     * exactly the per-frame allocation the engine contract forbids. `spawn` reads
     * its argument synchronously and copies every field, so reusing the objects
     * across shots is safe.
     */
    this._pelletDirs = Array.from({ length: 9 }, () => new THREE.Vector3(0, 0, -1));
    this._pelletShot = Array.from({ length: 9 }, () => ({
      origin: null, dir: null, speed: 0, damage: 0, penetration: 0,
      dragK: 0, dropoff: 0, maxRange: 0, weapon: null, tracer: false,
    }));
    /** One disc sample per pellet slot, so the RNG is called a fixed count. */
    this._discPool = Array.from({ length: 9 }, () => ({ x: 0, y: 0 }));
    this._firePayload = { weapon: null, origin: new THREE.Vector3(), dir: new THREE.Vector3(), seed: 0 };
    this._reloadPayload = { weapon: null, phase: 'start' };
    // `weapon:shell` carries the canonical { position, velocity } plus the real
    // case dimensions and a spin, so fx can size and tumble the brass instead of
    // guessing: a 9x19 case is less than half the length of a 5.56x45 one.
    this._shellPayload = {
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      weapon: null,
      caseLen: 0.0446,
      caseRadius: 0.00495,
      spin: 0,
    };
    this._pendingShots = 0;
    this._pendingFirst = false;

    // Deferred shell ejections (a case leaves the port a few ms after the shot).
    this._shellQueue = [];
    for (let i = 0; i < 8; i++) {
      this._shellQueue.push({ t: -1, pos: new THREE.Vector3(), vel: new THREE.Vector3() });
    }
    this._droppedMags = [];
    this._state = {
      ads: false,
      sprint: false,
      lowReady: false,
      speed: 0,
      crouch: false,
      airborne: false,
      trigger: false,
      empty: false,
    };
    // Preallocated HUD snapshot handed to `ui` (see getHudState).
    this._hudState = {
      name: '', mode: 'auto', ammo: 0, reserve: 0, magSize: 0,
      reloading: false, reloadProgress: 0, ads: false, spread: 0, firing: false,
      // Additive fields. `ui` reads the object by property, so extra keys are
      // ignored by a subscriber that predates them — the same additive-event
      // convention ARCHITECTURE.md uses for the non-canonical player events.
      /** True for a tube-fed weapon: draw the chamber and tube separately. */
      tubeFed: false,
      tube: 0,
      tubeCapacity: 0,
      /** 0..1 through a shell-by-shell reload, for the per-shell progress. */
      shellProgress: 0,
      /** True while the fore-end is cycling — the reticle should say so. */
      pumping: false,
    };
  }

  /* ====================================================================== */
  /*  init                                                                  */
  /* ====================================================================== */

  async init(ctx) {
    this.ctx = ctx;
    this.rng = ctx.rng.fork();
    this.mats = new WeaponMaterials(ctx);
    this.sim = new ProjectileSim(ctx);
    this.viewmodel = new Viewmodel(ctx, this.mats);
    // `?skin=<id>` selects the boot finish. Read here rather than in main.js so
    // the URL contract lives with the system that implements it. An unknown id
    // is warned about by `resolveSkin` and falls back to stock.
    const urlSkin = new URLSearchParams(globalThis.location?.search ?? '').get('skin');
    if (urlSkin && SKINS[urlSkin]) this.skin = urlSkin;

    /**
     * Persisted finish, applied BEFORE any model is built.
     *
     * Order matters: `resolveSkin` decides which materials a model resolves to,
     * and every model is built immediately after. Reading the saved skin later
     * would mean baking and uploading the stock materials first and then
     * reassigning every mesh — work `setSkin` can do, but it would be pure waste
     * on a boot that already takes 4-12 s.
     *
     * `?skin=` wins over storage, so a shared link always shows what the sender
     * linked to.
     */
    if (!urlSkin) {
      const saved = ctx.settings?.peek?.() ?? {};
      if (saved.skin && SKINS[saved.skin]) this.skin = saved.skin;
    }
    // three only honours `material.envMapIntensity` when the material carries its
    // OWN `envMap`; for a material lit by `scene.environment` the renderer
    // overwrites that uniform with `scene.environmentIntensity` every frame
    // (WebGLRenderer.setProgram, the isMeshStandardMaterial branch). The
    // viewmodel is drawn from its own scene, so ENV_OCCLUSION — how much of the
    // sky a shouldered weapon actually sees, see materials.js — has to be
    // expressed there or it is silently a no-op.
    ctx.viewScene.environmentIntensity = ENV_OCCLUSION;
    this.viewmodel.onClipEvent = (name, clip) => this._onClipEvent(name, clip);

    /**
     * The builder table IS the weapon list. Adding a weapon means adding a row
     * here and a def in defs.js; nothing else enumerates ids. `Digit1..9` is
     * bound by position from this table, so a fifth weapon needs a new binding
     * but not a new code path.
     */
    const builders = {
      rifle: buildRifle,
      smg: buildSmg,
      pistol: buildPistol,
      shotgun: buildShotgun,
    };
    const ids = Object.keys(builders);
    this.weaponIds_ = ids;
    let tris = 0;
    for (const id of ids) {
      // Built ONCE, in the stock finish. Skins do not rebuild geometry or the
      // scene graph — `applySkin` reassigns the material on each existing mesh.
      // Building four weapons x five skins would mean twenty sets of merged
      // geometry and twenty scene-graph subtrees for what is a material swap,
      // which is the expensive way round.
      const def = resolveSkin(WEAPON_DEFS[id], this.skin);
      def.cycleTime = 60 / def.rpm;
      const model = builders[id]();
      /**
       * `band` describes where a skin's scrolling highlight runs along this
       * weapon's barrel. Every model gets one, sized to its own geometry — the
       * strip is built from these numbers by `buildBandGeometry` and a weapon
       * with no `band` node simply never gets a highlight, rather than getting
       * one at the wrong length.
       *
       * The pistol is the case that matters: a 110 mm slide has no barrel to run
       * a band along, so it is omitted rather than given a 60 mm strip that would
       * hang off the front.
       */
      if (!model.nodes.band) {
        const z0 = model.nodes.magZ0 ?? -0.1;
        model.nodes.band = { z0, z1: model.nodes.muzzle?.[2] * 0.72, radius: 1.05, width: 0.017 };
      }
      const entry = this.viewmodel.addWeapon(model, def);
      tris += entry.tris;
      this.states.set(id, {
        def,
        pattern: buildRecoilPattern(def, Rng),
        mag: def.magSize,
        chambered: true,
        reserve: def.reserve,
        mode: def.modes[0],
        modeIndex: 0,
        /**
         * Shells currently in the magazine TUBE, for a `tubeCapacity` weapon.
         * Distinct from `mag`, which is what is in the chamber/gate. Null for
         * every magazine-fed weapon, and every tube code path is guarded on it.
         */
        tube: def.tubeCapacity ?? null,
        /** Set while a pump clip is running, so firing is locked out. */
        pumping: false,
      });
    }
    this.viewmodel.setActive(this.activeId);
    this.viewmodel.play('draw');

    /**
     * Install the boot skin's live effect, if it has one.
     *
     * `setSkin` does this on a CHANGE, so a boot that lands directly on a
     * reactive or gold skin would otherwise show a static version until the
     * player touched the menu — exactly the "the menu entry is lying" failure.
     * Placed after the models are built, since that is when the materials the
     * film attaches to exist.
     */
    const bootDef = this.states.get(this.activeId)?.def;
    if (bootDef?.skinEffect) {
      this.viewmodel.setSkinEffect(bootDef.skinEffect, bootDef.skinBand ?? null);
    }

    const t0 = performance.now();
    /**
     * The builder table IS the weapon list. Adding a weapon means adding a row
     * here and a def in defs.js; nothing else enumerates ids. `Digit1..9` is
     * bound by position from this table, so a fifth weapon needs a new binding
     * but no new code path.
     */
    // Event unsubscribe handles, torn down in dispose(). Initialised HERE and not
    // in the constructor: this is the first thing that pushes onto it, and the
    // constructor runs long before the subsystems exist, so a constructor
    // initialisation would be fine — but the array MUST exist before this push.
    // It was previously initialised a few lines below these two statements, which
    // made every boot die with "Cannot read properties of undefined (reading
    // 'push')" at the exact point the weapons subsystem started.
    this._off = [];
    this._off.push(
      ctx.events.on('player:land', (e) => this.viewmodel.land(Math.abs(e?.velocity ?? 3)))
    );
    this._off.push(ctx.events.on('player:jump', () => this.viewmodel.jump()));

    this.stats = { tris, drawCalls: 0, live: 0, fired: 0 };
    console.info(
      `[weapons] ${this.states.size} weapons (${this.weaponIds.join(', ')}) · ` +
        `${(tris / 1000).toFixed(1)}k tris viewmodel · skin "${this.skin}" · ` +
        `built in ${(performance.now() - t0).toFixed(0)}ms`
    );
  }

  /**
   * Compile every material every skin can produce, before the first frame.
   *
   * Same contract as `render` / `world` / `ai` (see ARCHITECTURE.md): build and
   * compile, without drawing a gameplay frame, spawning anything, or touching the
   * clock or RNG.
   *
   * This one is not optional in the way the others are. A skin swap assigns
   * materials that have never been drawn, and three compiles a program on first
   * use — measured at +33 to +36 programs and 640-900 ms when a single material
   * family appears mid-frame. A player who changes their weapon finish and then
   * pulls the trigger would eat exactly the stall this whole mechanism exists to
   * remove.
   *
   * `render` runs first in `prewarm()` (see src/core/prewarm.js) because it
   * patches every lit material with the CSM/AO/SSR injection, and a program
   * compiled off an unpatched material is thrown away by the first real frame.
   * `weapons` runs after it, so the patch is already in place.
   */
  prewarmMaterials(ctx = this.ctx) {
    const t0 = performance.now();
    /**
     * The EQUIPPED skin only. Warming all of them was the single largest
     * avoidable cost in the boot path: a remapped material is a different bake,
     * not just a different program, so the old all-skins loop generated and
     * uploaded 1024x1024 texture sets for every variant of every part on every
     * weapon — for skins the player may never pick. The rest are warmed by
     * `prewarmAllSkins`, which the settings menu calls when it opens.
     */
    const result = this.viewmodel.prewarmMaterials(ctx);
    if (result?.ok) {
      const n = Object.values(result.materials).reduce((a, b) => a + b, 0);
      console.info(
        `[weapons] prewarmed ${n} material slots for skin "${this.skin}" ` +
          `in ${(performance.now() - t0).toFixed(0)}ms ` +
          `(${SKIN_IDS.length - 1} other skins deferred to the menu)`
      );
    }
    return result;
  }

  /**
   * Warm every remaining skin. Called by the settings menu on open, NOT at boot.
   *
   * Exposed on the system rather than reached through the viewmodel so `ui` has
   * one call site and no knowledge of the viewmodel's internals.
   */
  prewarmAllSkins() {
    return this.viewmodel.prewarmAllSkins(this.ctx);
  }

  /* ====================================================================== */
  /*  public getters                                                        */
  /* ====================================================================== */

  get state() {
    return this.states.get(this.activeId);
  }

  get current() {
    return this.state?.def ?? null;
  }

  get weaponIds() {
    return [...this.states.keys()];
  }

  get ammo() {
    const s = this.state;
    if (!s) return { mag: 0, chambered: false, reserve: 0, magSize: 0, total: 0, empty: true };
    const mag = s.mag;
    const ch = s.chambered ? 1 : 0;
    /**
     * For a tube-fed weapon, `mag` is the CHAMBER (0 or 1) and the shells in the
     * tube are what the player can still reach. Reporting `tubeCapacity` as
     * `magSize` is what lets the existing pip-strip HUD draw a shotgun correctly
     * with no ui change at all: one pip for the chamber, six for the tube.
     */
    const tube = s.def.tubeCapacity ?? 0;
    return {
      mag: mag + ch + s.tube,
      inMag: mag,
      chambered: s.chambered,
      tube: s.tube ?? 0,
      tubeCapacity: tube,
      /** Whether the shell strip should be drawn as a shotgun's chamber+tube. */
      tubeFed: tube > 0,
      reserve: s.reserve,
      magSize: tube ? tube + 1 : s.def.magSize,
      total: mag + ch + (s.tube ?? 0) + s.reserve,
      empty: mag + ch === 0,
    };
  }

  get fireMode() {
    return this.state?.mode ?? 'semi';
  }

  get adsProgress() {
    return this.viewmodel?.adsT ?? 0;
  }

  /**
   * Is a reload in progress?
   *
   * `tubeLoad` is the shotgun's shell-by-shell reload and counts as a reload, or
   * the HUD would show no progress at all while six shells went in one at a time.
   * `pump` deliberately does NOT count: it is a cycle, not a reload, and treating
   * it as one would put a progress bar over the weapon on every single shot.
   */
  get reloading() {
    const n = this.viewmodel?.clipName;
    return n === 'reloadTac' || n === 'reloadEmpty' || n === 'tubeLoad';
  }

  /** Is the fore-end cycling? Drives the reticle and the HUD state. */
  get pumping() {
    return this.state?.pumping === true;
  }

  /**
   * Skin metadata for the settings menu, so `ui` never imports `skins.js`.
   *
   * A getter that builds a fresh array each call would be an allocation in a
   * menu constructor, which runs once, so it is built once here and cached. The
   * table itself is module-level and immutable.
   */
  get skinIds() {
    if (!this._skinIds) {
      this._skinIds = SKIN_IDS.map((id) => ({
        id,
        label: SKINS[id].label,
        desc: SKINS[id].desc ?? '',
      }));
    }
    return this._skinIds;
  }

  get inspecting() {
    return this.viewmodel?.clipName === 'inspect';
  }

  get switching() {
    return this._switchTo !== null;
  }

  get firing() {
    return this._sinceShot < 0.12;
  }

  /** Current spread cone half-angle in degrees — the crosshair should use this. */
  get spreadDegrees() {
    return this._spread;
  }

  muzzleWorld(out) {
    return this.viewmodel.muzzleWorld(out ?? this._tmp);
  }

  /**
   * HUD adapter polled by `ui` every lateUpdate. Shape is fixed by the contract
   * documented at the top of src/ui/index.js; the object is preallocated and
   * mutated in place because `ui` reads it once per frame and never keeps it.
   */
  getHudState() {
    const h = this._hudState;
    const s = this.state;
    if (!s) return h;
    const a = this.ammo;
    const vm = this.viewmodel;
    h.name = s.def.label ?? s.def.id;
    h.mode = s.mode;
    // `a.mag` counts the chambered round, so a topped-off rifle is 31. The HUD
    // draws one pip per round against magSize, so clamp the *display* to the
    // magazine capacity rather than overflowing the pip strip.
    h.ammo = Math.min(a.mag, a.magSize);
    h.reserve = a.reserve;
    h.magSize = a.magSize;
    h.tubeFed = a.tubeFed;
    h.tube = a.tube;
    h.tubeCapacity = a.tubeCapacity;
    h.pumping = s.pumping === true;
    h.reloading = this.reloading;
    // 0..1 through the active reload clip; the bar is meaningless otherwise.
    h.reloadProgress = h.reloading && vm?.clip?.duration
      ? Math.min(1, vm.clipT / vm.clip.duration)
      : 0;
    /**
     * For a shell-by-shell reload, which shell of how many the player is on.
     * A single progress bar across a six-shell load tells the player nothing
     * about how long is left; a discrete count does.
     */
    h.shellProgress = a.tubeFed && this._pendingTube
      ? Math.max(0, Math.min(this._pendingTube.want, this._pendingTube.done))
      : 0;
    h.ads = (vm?.adsT ?? 0) > 0.5;
    // `ui` maps this to reticle bloom as 4 + spread * 40 px, so hand it a
    // normalised 0..1 rather than raw degrees.
    h.spread = Math.min(1, Math.max(0, this._spread / 6));
    h.firing = this.firing;
    return h;
  }

  /* ====================================================================== */
  /*  weapon management                                                     */
  /* ====================================================================== */

  /**
   * Change the finish on every weapon.
   *
   * A material remap, so it is instant and safe mid-firefight: `applySkin`
   * reassigns materials on existing meshes and nothing else. The ammo state is
   * deliberately NOT reset — a cosmetic change must never cost the player a
   * magazine.
   *
   * @param {string} skinId  a key of SKINS
   * @returns {boolean}      false if the id was unknown (and nothing changed)
   */
  setSkin(skinId) {
    if (!SKINS[skinId]) {
      console.warn(`[weapons] unknown skin "${skinId}"`);
      return false;
    }
    if (skinId === this.skin) return true;
    this.skin = skinId;
    /**
     * The remap table is a property of the SKIN, not of the weapon — every
     * weapon uses the same `alu` -> `alu_desert` mapping. So the defs are updated
     * per weapon (they carry `skinMats` and their own copy, per the
     * module-singleton rule in resolveSkin) but the material reassignment is one
     * pass over every weapon.
     */
    for (const [id, st] of this.states) {
      const def = resolveSkin(WEAPON_DEFS[id], skinId);
      def.cycleTime = 60 / def.rpm;
      st.def = def;
    }
    const active = this.states.get(this.activeId)?.def;
    this.viewmodel.mats.setSkin(active?.skinMats ?? null);
    this.viewmodel.applySkinAll();
    /**
     * The live effect is installed AFTER the materials are resolved, because it
     * attaches to the resolved instances — sweeping a `iridescenceThicknessRange`
     * on a material the new skin does not use would be wasted work, and
     * `SkinFilm.attach` skips anything without the range, so this is naturally
     * safe either way.
     *
     * It is NOT gated on quality. The reactive finish is a few lines of shader
     * on parts that are already shaded, and the alternative — a phone player
     * seeing a menu entry that silently does nothing — is worse. If a measurement
     * ever shows it matters, the right fix is a `q.skinFx` flag read HERE, not a
     * divergent skin table.
     */
    this.viewmodel.setSkinEffect(active?.skinEffect ?? null, active?.skinBand ?? null);
    console.info(
      `[weapons] skin -> ${skinId}${active?.skinEffect ? ' (live effect)' : ''}`
    );
    return true;
  }

  get skinId() {
    return this.skin;
  }

  setWeapon(id) {
    if (!this.states.has(id) || id === this.activeId || this._switchTo) return false;
    this._switchTo = id;
    /**
     * Clear transient weapon state up front rather than at the end of the swap.
     * `pumping` in particular must not survive into the holster, or switching
     * away mid-pump and back would present a gun that can never fire again.
     */
    const from = this.state;
    if (from) from.pumping = false;
    this._pendingPump = false;
    this._pendingTube = null;
    this._switchTimer = this.viewmodel.play('holster');
    return true;
  }

  nextWeapon() {
    const ids = this.weaponIds;
    const i = ids.indexOf(this.activeId);
    return this.setWeapon(ids[(i + 1) % ids.length]);
  }

  cycleFireMode() {
    const s = this.state;
    if (!s || s.def.modes.length < 2) return s?.mode;
    s.modeIndex = (s.modeIndex + 1) % s.def.modes.length;
    s.mode = s.def.modes[s.modeIndex];
    this._burstLeft = 0;
    return s.mode;
  }

  /**
   * Can this weapon take a round right now?
   *
   * The two ammo models are genuinely different and the difference has to be
   * visible before the player pulls the trigger:
   *   - magazine fed: a partial magazine still fires, so only `magSize` and
   *     `reserve` matter.
   *   - tube fed: the CHAMBER is what fires, and the tube only feeds it. So
   *     `magSize: 1` and `chambered` is the whole question — a full tube with an
   *     empty chamber is an empty gun, which is the entire awkwardness of a
   *     shotgun and the reason this check cannot be shared with the rifle's.
   */
  _canReload(s) {
    if (s.reserve <= 0) return false;
    if (s.def.tubeCapacity) return !(s.chambered && s.tube >= s.def.tubeCapacity);
    return s.mag < s.def.magSize;
  }

  reload() {
    const s = this.state;
    if (!s || this.reloading || this.switching) return false;
    if (!this._canReload(s)) return false;
    this.viewmodel.stopClip();
    if (s.def.tubeCapacity) {
      // A different clip entirely: one shell at a time, six-plus-one beats.
      this.viewmodel.play('tubeLoad');
      this._pendingTube = {
        want: Math.min(
          s.def.tubeCapacity - (s.tube ?? 0) + (s.chambered ? 0 : 1),
          Math.max(0, s.reserve)
        ),
        done: 0,
      };
      return true;
    }
    const empty = s.mag === 0 && !s.chambered;
    this.viewmodel.play(empty ? 'reloadEmpty' : 'reloadTac');
    this._pendingReloadEmpty = empty;
    return true;
  }

  inspect() {
    if (this.reloading || this.switching || this.inspecting) return false;
    this.viewmodel.play('inspect');
    return true;
  }

  /* ====================================================================== */
  /*  firing                                                                */
  /* ====================================================================== */

  canFire() {
    const s = this.state;
    if (!s) return false;
    if (this.reloading || this.switching) return false;
    if (this._fireTimer > 0) return false;
    // Mid-pump: the fore-end is back and the chamber is empty. Refusing here is
    // what makes the weapon feel like a shotgun rather than a slow rifle.
    if (s.pumping) return false;
    return s.chambered;
  }

  /** One round leaves the barrel. Returns false if the trigger clicked dry. */
  tryFire() {
    const s = this.state;
    if (!s) return false;
    if (this.reloading || this.switching || this._fireTimer > 0) return false;
    if (!s.chambered) {
      // Dry: lock the bolt back and let the player know by feel.
      this.viewmodel.boltHold = 1;
      this._fireTimer = 0.25;
      return false;
    }
    if (this.inspecting) this.viewmodel.stopClip();

    const def = s.def;
    const first = this._sinceShot > 0.35;
    // ---- feed the next round ----
    s.chambered = false;
    if (s.mag > 0) {
      s.mag--;
      s.chambered = true;
    } else {
      this.viewmodel.boltHold = 1;
    }

    // ---- deterministic recoil pattern ----
    const idx = Math.min(this._shotIndex, def.recoil.patternLength - 1);
    const pitch = s.pattern[idx * 2];
    const yaw = s.pattern[idx * 2 + 1];
    this._shotIndex++;

    // ---- aim: camera forward + a spread cone ----
    const cam = this.ctx.camera;
    cam.updateMatrixWorld();
    this._camDir.set(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
    this._dir.copy(this._camDir);
    const spreadRad = this._spread * DEG;
    if (spreadRad > 1e-5) {
      const d = this.rng.disc(this._disc ?? (this._disc = { x: 0, y: 0 }));
      this._right.set(1, 0, 0).applyQuaternion(cam.quaternion);
      this._up.set(0, 1, 0).applyQuaternion(cam.quaternion);
      this._dir
        .addScaledVector(this._right, Math.tan(spreadRad) * d.x)
        .addScaledVector(this._up, Math.tan(spreadRad) * d.y)
        .normalize();
    }

    // ---- projectile(s) ----
    this.viewmodel.muzzleWorld(this._muzzle);
    const seed = this.rng.u32();
    const shot = {
      origin: this._muzzle,
      dir: this._dir,
      speed: def.muzzleVelocity,
      damage: def.damage,
      penetration: def.penetration,
      dragK: def.dragK,
      dropoff: def.dropoff,
      maxRange: def.maxRange,
      weapon: def,
      tracer: this.stats.fired % def.tracerEvery === 0,
    };
    /**
     * A `pellets` weapon (shotgun) fires one travelling projectile per pellet,
     * distributed across a FIXED DISC rather than a cone. The disc is a property
     * of the weapon, not of the trigger pull, which is what makes a shotgun
     * learnable: the same shell throws the same pattern every time, so the
     * player learns the pattern and its drift instead of learning a fight
     * against randomness.
     *
     * Only the CENTRE pellet carries the tracer, for the reason in the def: a
     * nine-line tracer fan is visual noise, and one line is enough to read the
     * range.
     *
     * The offsets are preallocated in the constructor and refilled per shot, so
     * this loop allocates nothing.
     */
    if (def.pellets) {
      const n = Math.min(def.pellets, this._pelletDirs.length);
      const r = (def.patternRadius ?? 1.7) * DEG;
      this._right.set(1, 0, 0).applyQuaternion(cam.quaternion);
      this._up.set(0, 0, 1).applyQuaternion(cam.quaternion);
      for (let i = 0; i < n; i++) {
        // `disc` gives a uniform point in the unit disc; scaling by the pattern
        // half-angle puts it on the actual shot cone.
        const d = this.rng.disc(this._discPool[i]);
        const dOut = this._pelletDirs[i];
        dOut
          .copy(this._dir)
          .addScaledVector(this._right, Math.tan(r) * d.x)
          .addScaledVector(this._up, Math.tan(r) * d.y)
          .normalize();
        // Reuse one payload object: `spawn` copies everything it needs out of
        // it synchronously, and the sim never retains the caller's object.
        const p = this._pelletShot[i];
        p.origin = this._muzzle;
        p.dir = dOut;
        p.speed = def.muzzleVelocity;
        p.damage = def.damage;
        p.penetration = def.penetration;
        p.dragK = def.dragK;
        p.dropoff = def.dropoff;
        p.maxRange = def.maxRange;
        p.weapon = def;
        p.tracer = i === 0 && shot.tracer;
        this.sim.spawn(p);
      }
    } else {
      this.sim.spawn(shot);
    }

    // ---- feedback ----
    this.viewmodel.addRecoil(pitch, yaw, first);
    const p = this.player;
    if (p?.addRecoil) {
      // The camera climb is the learnable part; the viewmodel kick is the feel.
      p.addRecoil(pitch, yaw, def.recoil.roll * 0.35, def.recoil.punch);
    }
    /**
     * A tube-fed weapon ejects its hull from the gate on the pump's forward
     * stroke, not from an ejection port. A magazine-fed one keeps the
     * existing port-then-delayed-ejection behaviour below. Both emit the same
     * `weapon:shell` event, so fx needs no idea which weapon it is watching.
     */
    const tubeFed = !!def.tubeCapacity;
    this._spread = Math.min(def.spreadMax, this._spread + def.spreadPerShot);
    this._fireTimer = 60 / def.rpm;
    this._sinceShot = 0;
    this.stats.fired++;
    this._pendingShots++;
    this._pendingFirst = this._pendingFirst || first;

    /**
     * A pump-action weapon has to be pumped before it fires again, and that is
     * a real mechanical delay rather than a rate-of-fire number — which is why
     * `def.rpm` alone would be a lie for it. `pumping` blocks the next trigger
     * pull, and the pump clip is what clears it. Setting it here rather than
     * waiting for the clip keeps the state honest if the pump is interrupted.
     */
    if (def.pumpTime) {
      s.pumping = true;
      this._pendingPump = true;
    }
    this._fireSeed = seed;

    // Shell leaves the port shortly after the shot, once the bolt is back.
    // A tube-fed weapon has no port — `_dropHull` handles it on the pump stroke.
    if (!tubeFed) this._queueShell(Math.min(0.05, this._fireTimer * 0.45));
    return true;
  }

  _queueShell(delay) {
    for (const q of this._shellQueue) {
      if (q.t < 0) {
        q.t = delay;
        return q;
      }
    }
    return null;
  }

  /* ====================================================================== */
  /*  reload / clip callbacks                                               */
  /* ====================================================================== */

  _onClipEvent(name, clipName) {
    const s = this.state;
    const isReload = clipName === 'reloadTac' || clipName === 'reloadEmpty';
    switch (name) {
      case 'start':
        if (isReload) this._emitReload('start');
        break;
      case 'magout':
        if (isReload) this._emitReload('magout');
        break;
      case 'magdrop':
        if (isReload) this._dropMagazine();
        break;
      /**
       * Shotgun-only beats, emitted once per shell by the `tubeLoad` clip.
       * `shellDrop` is offset BEFORE `shellIn` in the clip, so a spent hull is
       * always ejected before the next round is credited.
       */
      case 'shellDrop':
        if (clipName === 'tubeLoad') this._dropHull();
        break;
      case 'shellIn':
        if (clipName === 'tubeLoad') this._loadShell();
        break;
      /**
       * The pump's back stroke. This is where a shell is moved from the tube into
       * the chamber, which is the mechanical reason a shotgun is slower to fire
       * than its rpm suggests.
       */
      case 'pump':
        this._chamberFromTube();
        // The pump is over: the gun can fire again as soon as a round is chambered.
        this.state.pumping = false;
        this._pumpingWeapon = null;
        break;
      case 'magin':
        if (isReload) {
          this._emitReload('magin');
          this._completeReload(clipName === 'reloadEmpty');
        }
        break;
      case 'boltrelease':
        this.viewmodel.boltHold = 0;
        break;
      case 'end':
        if (isReload) {
          this._emitReload('end');
          this.viewmodel.boltHold = 0;
        }
        // A finished tube load clears the shell counter. Also the safety net for
        // an interrupted pump: if the clip is stopped rather than completing,
        // `pumping` must not stay latched or the gun is permanently dead.
        if (clipName === 'tubeLoad') this._pendingTube = null;
        if (clipName === 'pump') {
          const ps = this.state;
          if (ps) ps.pumping = false;
        }
        if (clipName === 'holster' && this._switchTo) {
          this.activeId = this._switchTo;
          this._switchTo = null;
          this.viewmodel.setActive(this.activeId);
          this.viewmodel.play('draw');
          this._shotIndex = 0;
          this._spread = 0;
        }
        break;
      default:
        break;
    }
  }

  /**
   * The chambered-round model: a tactical reload keeps the round in the chamber
   * and gives you magSize+1; an empty reload has to feed one out of the fresh
   * magazine, so you end up with exactly magSize.
   */
  _completeReload(empty) {
    const s = this.state;
    if (!s) return;
    const want = s.def.magSize - s.mag;
    const take = Math.min(want, s.reserve);
    s.reserve -= take;
    s.mag += take;
    if (empty && !s.chambered && s.mag > 0) {
      s.mag--;
      s.chambered = true;
    }
    this._shotIndex = 0;
  }

  _emitReload(phase) {
    this._reloadPayload.weapon = this.current;
    this._reloadPayload.phase = phase;
    this.ctx.events.emit('weapon:reload', this._reloadPayload);
  }

  /* ====================================================================== */
  /*  tube-fed (shotgun) ammo                                                */
  /* ====================================================================== */

  /**
   * Credit ONE shell.
   *
   * Deliberately not `reserve--` / `mag++`: a shotgun has no magazine, so the
   * round goes into the TUBE if the chamber is occupied, or straight into the
   * CHAMBER if it is empty. Which of the two happened is the difference between
   * a gun that fires on the next pull and one that has to be pumped first, and
   * getting it backwards produces the classic bug where a freshly reloaded
   * shotgun is mysteriously empty.
   */
  _loadShell() {
    const s = this.state;
    if (!s || !s.def.tubeCapacity) return;
    if (s.reserve <= 0) return;
    /**
     * Decide WHERE the shell goes BEFORE debiting the reserve.
     *
     * The obvious order — `reserve--` then try to place the round — silently
     * destroys ammunition: if the tube is already full and the chamber is
     * occupied there is nowhere for the shell to go, and a reserve that has
     * already been debited is a round the player can never fire. The `tubeLoad`
     * clip emits one `shellIn` per shell it animated, and a mis-sized reload
     * would eat reserve a shell at a time with no visible effect.
     */
    const intoChamber = !s.chambered;
    if (!intoChamber && s.tube >= s.def.tubeCapacity) return;
    s.reserve--;
    if (intoChamber) {
      s.chambered = true;
      s.mag = 1;
    } else {
      s.tube++;
    }
    if (this._pendingTube) this._pendingTube.done++;
    this._emitReload('magin');
  }

  /** Move one shell from the tube into the chamber, on the pump's back stroke. */
  _chamberFromTube() {
    const s = this.state;
    if (!s || !s.def.tubeCapacity) return;
    if (s.chambered || s.tube <= 0) return;
    s.tube--;
    s.chambered = true;
    s.mag = 1;
  }

  /**
   * Throw the spent hull out of the loading gate.
   *
   * A shotgun does not eject a case the way a rifle does — there is no ejection
   * port in the cycle, because the action is loaded from below. The hull leaves
   * downward through the gate as the fore-end is pushed forward. Emitted as
   * `weapon:shell` with the real 12-gauge dimensions, so fx tumbles a plastic
   * hull rather than a brass case.
   */
  _dropHull() {
    const s = this.state;
    if (!s || !s.def.tubeCapacity) return;
    const vm = this.viewmodel;
    const p = this._shellPayload;
    vm.ejectWorld(p.position);
    vm.ejectVelocity(p.velocity, 1.6 + this.rng.float() * 0.7);
    const pv = this.player?.velocity;
    if (pv) p.velocity.add(pv);
    // Down and forward out of the gate, not up and to the right.
    p.velocity.multiplyScalar(0.5);
    p.velocity.y -= 1.4;
    p.velocity.z -= 0.6;
    p.weapon = this.current;
    const shell = vm.active?.shell;
    p.caseLen = shell?.caseLen ?? 0.0635;
    p.caseRadius = shell?.rimR ?? 0.00925;
    p.spin = 14 + this.rng.float() * 18;
    this.ctx.events.emit('weapon:shell', p);
  }

  /** Spawn the discarded magazine as a real rigid body in the world. */
  _dropMagazine() {
    const phys = this.physics ?? (this.physics = this.ctx.peek('physics'));
    const w = this.viewmodel.active;
    if (!w) return;
    const proxy = this._magProxy(w);
    if (!proxy) return;
    const mag = w.parts.magazine;
    mag.updateMatrixWorld();
    proxy.group.position.setFromMatrixPosition(mag.matrixWorld);
    proxy.group.quaternion.setFromRotationMatrix(mag.matrixWorld);
    proxy.group.visible = true;
    // Magazine geometry hangs below its origin, so bias the body centre down.
    const half = w.magLen * 0.45;
    proxy.group.position.y -= half * 0.4;

    const vel = this._tmp.set(0, -0.7, 0);
    const pv = this.player?.velocity;
    if (pv) vel.add(pv);
    vel.x += this.rng.signed() * 0.25;
    vel.z += this.rng.signed() * 0.25;

    if (phys?.spawnDebris) {
      proxy.body = phys.spawnDebris(proxy.group.position, vel, {
        size: Math.max(0.02, w.magLen * 0.28),
        surface: 'rubber',
        mass: 0.38,
        lifetime: 22,
        restitution: 0.18,
        object3D: proxy.group,
      });
      proxy.until = this.ctx.time.elapsed + 22;
    } else {
      proxy.until = this.ctx.time.elapsed + 2;
    }
  }

  /** Two reusable world-space magazine props per weapon. */
  _magProxy(w) {
    if (!this._magPools) this._magPools = new Map();
    let pool = this._magPools.get(w.id);
    if (!pool) {
      pool = [];
      for (let i = 0; i < 2; i++) {
        const group = new THREE.Object3D();
        group.name = `dropped-mag-${w.id}-${i}`;
        group.visible = false;
        // Share the viewmodel's geometry and materials; the world copy needs no
        // resources of its own.
        w.parts.magazine.traverse((o) => {
          if (o.isMesh) {
            const m = new THREE.Mesh(o.geometry, o.material);
            m.position.copy(o.position);
            m.quaternion.copy(o.quaternion);
            m.castShadow = true;
            group.add(m);
          }
        });
        this.ctx.scene.add(group);
        pool.push({ group, body: null, until: 0 });
        this._droppedMags.push(pool[i]);
      }
      this._magPools.set(w.id, pool);
    }
    // Reuse the oldest.
    let best = pool[0];
    for (const p of pool) if (p.until < best.until) best = p;
    if (best.body && this.physics?.removeRigidBody) this.physics.removeRigidBody(best.body);
    best.body = null;
    return best;
  }

  /* ====================================================================== */
  /*  frame                                                                 */
  /* ====================================================================== */

  fixedUpdate(h) {
    this.sim.fixedUpdate(h);
  }

  update(dt, ctx) {
    const s = this.state;
    if (!s) return;
    const def = s.def;
    const input = ctx.input;
    const player = this.player ?? (this.player = ctx.peek('player'));
    const st = this._state;

    this._sinceShot += dt;
    if (this._fireTimer > 0) this._fireTimer -= dt;
    if (this._burstCooldown > 0) this._burstCooldown -= dt;

    // ---- spread recovery -------------------------------------------------
    const rest = this._restSpread(def, player, st);
    this._spread = Math.max(rest, this._spread - def.spreadDecay * dt * (1 + this.adsProgress));
    if (this._sinceShot > 0.6) this._shotIndex = 0;

    // ---- gather state ----------------------------------------------------
    const live = !input.frozen && input.enabled !== false && this.debugMode === null;
    st.ads = live ? input.ads || player?.adsRequested === true : this.debugMode === 'ads';
    st.sprint = live ? player?.sprinting === true && this._sinceShot > 0.3 : false;
    st.speed = player?.horizontalSpeed ?? player?.speed ?? 0;
    st.crouch = player?.stance === 'crouch';
    st.airborne = player?.airborne === true;
    st.lowReady = player?.state === 'mantle' || player?.mantling === true;
    st.empty = s.mag === 0 && !s.chambered;
    /**
     * Mid-pump reads as "cannot fire" to the viewmodel so the weapon holds its
     * cycling pose rather than returning to a ready state while the fore-end is
     * still back. A separate flag rather than folding it into `empty`, because
     * the two mean different things to the HUD: empty is out of ammunition,
     * pumping is a cycle in progress with a round possibly waiting in the tube.
     */
    if (s.def.pumpTime) st.pumping = s.pumping === true;

    // ---- input -----------------------------------------------------------
    if (live) {
      if (input.actionPressed('reload')) this.reload();
      if (input.pressed('KeyB')) this.cycleFireMode();
      if (input.pressed('KeyI')) this.inspect();
      /**
       * Number-key weapon select, bound by POSITION in the builder table rather
       * than by hard-coded ids, so adding a weapon needs no new binding code
       * here. `Digit1`..`Digit4` cover the current four; a fifth weapon would
       * need one more line, and that is deliberate — a silent no-op on an
       * unbound key is a worse failure than a missing binding.
       */
      for (let i = 0; i < this.weaponIds_.length && i < 9; i++) {
        if (input.pressed(`Digit${i + 1}`)) this.setWeapon(this.weaponIds_[i]);
      }
      if (input.pressed('Tab')) this.nextWeapon();
      if (input.wheel) this.nextWeapon();
      this._runTrigger(dt, input.fire, input.firePressed, def, s);
      st.trigger = input.fire && this.canFire();
      /**
       * Auto-reload on a dry trigger pull, like every modern shooter.
       *
       * The condition is broader than "the magazine is empty" for a tube-fed
       * weapon: a shotgun whose CHAMBER is empty but whose tube is full still
       * fires nothing until it is pumped, and the player cannot see that from the
       * trigger. Offering the reload on a dry pull is the only way the state is
       * communicated without a new HUD element.
       */
      if (input.firePressed && st.empty && this._canReload(s)) this.reload();
    } else if (this.debugMode) {
      this._runDebug(ctx);
      st.trigger = this._sinceShot < 0.09;
    }

    // Push the ADS curve to the player so camera FOV / move speed follow it.
    player?.setAdsProgress?.(this.viewmodel.adsT);

    /**
     * Start the pump, and clear `pumping` when it lands.
     *
     * Deferred to here rather than to `tryFire` so the pump clip begins on the
     * frame AFTER the shot, which is what lets the muzzle flash and recoil peak
     * before the fore-end starts moving. It is also the only place a clip can be
     * started that is guaranteed not to collide with the shell's own
     * `weapon:fire` emission in `lateUpdate`.
     */
    if (this._pendingPump) {
      this._pendingPump = false;
      const ps = this.state;
      if (ps && ps.def.pumpTime) this.viewmodel.play('pump');
    }

    this.stats.live = this.sim.stats.live;
    this.stats.fired = this.sim.stats.fired;
  }

  /** Fire-mode state machine. */
  _runTrigger(dt, held, pressed, def, s) {
    switch (s.mode) {
      case 'auto':
        if (held) this.tryFire();
        break;
      case 'burst':
        if (pressed && this._burstLeft === 0 && this._burstCooldown <= 0) {
          this._burstLeft = def.burstCount;
        }
        if (this._burstLeft > 0 && this._fireTimer <= 0) {
          if (this.tryFire()) {
            this._burstLeft--;
            this._fireTimer = 60 / def.burstRpm;
            if (this._burstLeft === 0) this._burstCooldown = def.burstDelay;
          } else {
            this._burstLeft = 0;
          }
        }
        break;
      default: // semi
        if (pressed) this.tryFire();
        break;
    }
  }

  _restSpread(def, player, st) {
    let base = lerp(def.spreadHip, def.spreadAds, this.adsProgress);
    if (st.crouch) base *= SPREAD_MODS.crouch;
    if (player?.stance === 'prone') base *= SPREAD_MODS.prone;
    if (st.speed < 0.4) base *= SPREAD_MODS.still;
    else if (st.speed > 3.2) base *= SPREAD_MODS.walking;
    if (st.sprint) base *= SPREAD_MODS.sprinting;
    if (st.airborne) base *= SPREAD_MODS.airborne;
    return base;
  }

  lateUpdate(dt, ctx) {
    const vm = this.viewmodel;
    if (!vm) return;
    vm.update(dt, this._state);

    // ---- muzzle flash / audio, now that the pose is final ---------------
    if (this._pendingShots > 0) {
      const def = this.current;
      vm.muzzleWorld(this._firePayload.origin);
      vm.boreDir(this._firePayload.dir);
      this._firePayload.weapon = def;
      this._firePayload.seed = this._fireSeed >>> 0;
      for (let i = 0; i < this._pendingShots; i++) {
        ctx.events.emit('weapon:fire', this._firePayload);
      }
      this._pendingShots = 0;
      this._pendingFirst = false;
    }

    // ---- deferred shell ejection ---------------------------------------
    for (const q of this._shellQueue) {
      if (q.t < 0) continue;
      q.t -= dt;
      if (q.t > 0) continue;
      q.t = -1;
      vm.ejectWorld(this._shellPayload.position);
      vm.ejectVelocity(this._shellPayload.velocity, 2.3 + this.rng.float() * 1.2);
      const pv = this.player?.velocity;
      if (pv) this._shellPayload.velocity.add(pv);
      this._shellPayload.velocity.y += 1.1;
      this._shellPayload.weapon = this.current;
      const shell = vm.active?.shell;
      this._shellPayload.caseLen = shell?.caseLen ?? 0.0446;
      this._shellPayload.caseRadius = shell?.rimR ?? 0.00495;
      this._shellPayload.spin = 28 + this.rng.float() * 34;
      ctx.events.emit('weapon:shell', this._shellPayload);
    }

    // ---- retire dropped magazines --------------------------------------
    if (this._droppedMags.length) {
      const now = ctx.time.elapsed;
      for (const p of this._droppedMags) {
        if (p.group.visible && p.until && now > p.until) {
          p.group.visible = false;
          if (p.body && this.physics?.removeRigidBody) {
            this.physics.removeRigidBody(p.body);
            p.body = null;
          }
        }
      }
    }
  }

  /* ====================================================================== */
  /*  capture harness                                                       */
  /* ====================================================================== */

  /**
   * Freeze the viewmodel in a photogenic state.
   * The harness applies a shot, then pumps `SETTLE` frames before grabbing the
   * frame, so 'fire' schedules a short burst that peaks right at the capture.
   */
  debugPose(kind = 'idle', opts = {}) {
    const vm = this.viewmodel;
    this.debugMode = kind;
    this.setWeaponImmediate('rifle');
    /**
     * `debugPose` is the capture harness's entry point and it always poses the
     * RIFLE, on purpose: the `weapon` / `ads` / `muzzle` shots are the baseline
     * image set every optimisation is judged against, and changing which weapon
     * they show would invalidate it. A shotgun review uses the standalone
     * `/src/weapons/preview.html?w=shotgun` page, not the shot list.
     */
    vm.stopClip();
    vm.recPos.reset();
    vm.recRot.reset();
    vm.settle.reset();
    vm.lag.reset();
    vm.lagRot.reset();
    vm.boltHold = 0;
    vm.boltCycle = 0;
    vm.sprintT = 0;
    vm.lowReadyT = 0;
    vm.bobPhase = 0;
    vm._angVel.yaw = 0;
    vm._angVel.pitch = 0;
    vm._hasPrev = false;
    // A fixed, non-zero noise phase: a settled but not artificially symmetric pose.
    vm.noiseT = 12.37;
    vm.debugFrozen = true;
    this._spread = kind === 'ads' ? 0.24 : 2.05;
    this._sinceShot = 10;
    this._debugFrame = 0;

    const s = this.state;
    if (s) {
      s.mag = kind === 'fire' ? 22 : s.def.magSize;
      s.chambered = true;
      s.reserve = s.def.reserve;
      // A rifle has no tube, but leaving this null-safe costs nothing and keeps
      // the pose correct if the harness is ever pointed at a tube-fed weapon.
      if (s.def.tubeCapacity) s.tube = s.def.tubeCapacity;
    }

    if (kind === 'ads') {
      vm.adsT = 1;
      this._state.ads = true;
    } else {
      vm.adsT = 0;
      this._state.ads = false;
    }
    this._state.sprint = false;
    this._state.speed = 0;
    this._state.trigger = false;
    // Frames (at the harness's fixed 60 Hz) on which to fire for the 'fire'
    // shot. The burst has to land at the END of the harness's settle window: a
    // flash core lives 52 ms (~3 frames), so the last rounds must leave the
    // barrel a frame or two before the grab or there is nothing to photograph.
    // `grabFrame` is how many frames the harness will pump — it is a CLI flag
    // (`--settle`), so it cannot be hard-coded here. The offsets below straddle
    // the grab because the harness pumps on its own rAF chain, which can land a
    // frame either side of the engine's.
    // A flash core lives 52 ms — about three frames at 60 Hz — while the exact
    // frame the shutter lands on is only known to within a handful of frames
    // (the harness pumps its settle count on its own rAF chain, then the
    // screenshot RPC costs a few more). So: three spaced rounds early to fill
    // the frame with drifting smoke, brass in flight and a tracer, then a
    // sustained tail on a 2-frame cadence, so a flash is lit continuously
    // across the whole uncertainty window.
    //
    // The cadence was 3 frames, which is the flash core's own lifetime rounded
    // UP: measured across settle 86/88/90/92/94, frame 90 landed in the trough
    // between two cores and photographed a dying flash (10k hot pixels against
    // 26-29k on either side). Two frames guarantees overlap.
    if (kind === 'fire') {
      const grab = Math.round(opts?.grabFrame ?? 90);
      const frames = [grab - 26, grab - 19, grab - 12];
      for (let f = grab - 6; f <= grab + 18; f += 2) frames.push(f);
      this._scriptFrames = frames.filter((f) => f >= 2);
    } else {
      this._scriptFrames = null;
    }
    return kind;
  }

  /** Swap without the draw animation (harness + debug only). */
  setWeaponImmediate(id) {
    if (!this.states.has(id)) return false;
    this._switchTo = null;
    this.activeId = id;
    this.viewmodel.setActive(id);
    return true;
  }

  _runDebug(ctx) {
    this._debugFrame = (this._debugFrame ?? 0) + 1;
    const frames = this._scriptFrames;
    if (!frames) return;
    for (const f of frames) {
      if (f === this._debugFrame) {
        this._fireTimer = 0;
        this.tryFire();
      }
    }
  }

  /* ====================================================================== */

  resize() {}

  dispose() {
    for (const off of this._off ?? []) off();
    this.sim?.clear();
    for (const p of this._droppedMags) {
      p.group.removeFromParent();
      if (p.body && this.physics?.removeRigidBody) this.physics.removeRigidBody(p.body);
    }
    this._droppedMags.length = 0;
    this.viewmodel?.dispose();
    this.mats?.dispose();
  }
}
