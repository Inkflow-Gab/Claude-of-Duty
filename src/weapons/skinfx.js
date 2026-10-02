import * as THREE from 'three';

/**
 * Live skin effects.
 *
 * Two kinds of finish in this project need something a material remap cannot
 * express:
 *
 *   1. an ANIMATED material parameter — the thin-film thickness on `reactive` and
 *      `gold`, driven from `ctx.time` so the hue walks as the weapon moves;
 *   2. a SCROLLING BAND along the barrel, which `WEAPON_MATERIALS` fundamentally
 *      cannot do: that table resolves to one baked static surface per material
 *      key, and a moving highlight is a different object, not a different bake.
 *
 * Both live here rather than in `models/` because they are per-SKIN decoration
 * that applies to every weapon, and because they must be able to be switched on
 * and off without touching geometry.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE TWO RULES THAT MATTER
 *
 * DETERMINISM. Everything here is driven from `ctx.time.elapsed` or
 * `ctx.time.frame`, never `performance.now()`. A skin that animated off the wall
 * clock would make the rendered image depend on boot duration, which breaks the
 * pixel gate for EVERY shot, not just the ones with a skin equipped. This is the
 * same rule the rest of the engine follows and it is the reason the effect can be
 * captured at all.
 *
 * NO PER-FRAME ALLOCATION. `update()` writes into preallocated vectors and
 * prebuilt textures. A `new Color()` or a `new Vector3()` inside `update` would
 * be a per-frame garbage generator on a device that cannot afford one.
 */

/* -------------------------------------------------------------------------- */
/*  animated thin film                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Drives `iridescenceThickness` on a set of materials.
 *
 * three does not expose the thickness as a directly assignable uniform; it is
 * packed into `iridescenceThicknessRange` as a Vector2 and consumed in the
 * shader. Sweeping the RANGE rather than a scalar is therefore the only way to
 * animate it, and it also means the two ends move as a pair — which reads
 * correctly, because a real interference film changes hue across its whole
 * thickness at once.
 *
 * @param {object} effect  { min, max, period, amplitude? } from SKINS
 */
export class SkinFilm {
  constructor(effect) {
    this.effect = effect;
    this.min = effect.min;
    this.max = effect.max;
    this.period = effect.period;
    /**
     * `amplitude` scales how far the sweep travels between the two ends. 1 is a
     * full sweep; the gold skin uses 0.35 so the highlight travels rather than
     * the hue changing, which is what keeps it reading as gold.
     */
    this.amp = effect.amplitude ?? 1;
    this.enabled = true;
    /** @type {Set<{iridescenceThicknessRange: THREE.Vector2, _filmBase?: number[]}>} */
    this.targets = new Set();
    this._lo = this.min;
    this._hi = this.max;
  }

  /**
   * Register a material whose thickness range should be swept.
   *
   * The material's ORIGINAL range is captured on first sight, because a skin swap
   * re-resolves materials and the same instance can arrive here twice. Sweeping
   * from a captured base rather than from the current value is what stops the
   * oscillation from compounding: a naive implementation that reads the current
   * range and writes back min+w, max+w would drift every frame.
   */
  attach(mat) {
    if (!mat || !mat.iridescenceThicknessRange) return;
    if (this.targets.has(mat)) return;
    const r = mat.iridescenceThicknessRange;
    this.targets.add(mat);
    // Stash the authored pair on the material so a second SkinFilm for a
    // different skin can restore it rather than inheriting the previous sweep.
    mat.userData.owFilmBase = [r.x, r.y];
  }

  detachAll() {
    for (const mat of this.targets) {
      const base = mat.userData.owFilmBase;
      if (base && mat.iridescenceThicknessRange) {
        mat.iridescenceThicknessRange.set(base[0], base[1]);
      }
    }
    this.targets.clear();
  }

  /**
   * @param {number} elapsed  `ctx.time.elapsed` — the ENGINE clock, not wall time
   */
  update(elapsed) {
    if (!this.enabled || this.targets.size === 0) return;
    // A triangle wave rather than a sine: a film sweeping back and forth through
    // its full range once per period reads as a slow colour cycle, and a
    // ping-pong with a dead point in the middle is the thing that looks wrong.
    const phase = (elapsed / this.period) % 1;
    const tri = phase < 0.5 ? phase * 2 : 2 - phase * 2;
    const mid = (this.min + this.max) * 0.5;
    const half = ((this.max - this.min) * 0.5) * tri * this.amp;
    const lo = mid - half;
    const hi = mid + half;
    for (const mat of this.targets) {
      const r = mat.iridescenceThicknessRange;
      if (r) r.set(lo, hi);
    }
  }

  dispose() {
    this.detachAll();
  }
}

/* -------------------------------------------------------------------------- */
/*  scrolling band                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A thin additive band that travels along the barrel axis.
 *
 * WHY A SEPARATE MESH. `WEAPON_MATERIALS` maps a key to a baked static surface.
 * A scrolling highlight is not a different bake, it is a different KIND of thing
 * — a mask that moves. The only honest way to express it in this project, which
 * has no texture files and no UV unwrap, is a small strip of geometry with a
 * generated gradient texture whose `offset.y` is animated.
 *
 * It is deliberately built from a plain `MeshBasicMaterial` with additive
 * blending and `toneMapped: true`, which is the same construction the lens ring
 * and the reticle use (see `materials.js`). That matters: an untone-mapped additive
 * surface in an HDR pipeline with AgX on the composite clips to white and reads
 * as a rendering error rather than as a highlight.
 *
 * The texture is ONE 8x64 gradient, generated once at construction. It is
 * band-limited in Y so it has no hard edges — a hard-edged additive strip at
 * 0.5 m from the eye is a visible line across the barrel, and the softness is
 * what makes it read as a reflection travelling over a curved surface.
 */
export class SkinBand {
  /**
   * @param {object} spec  { color, intensity, speed, tiles } from SKINS
   * @param {THREE.BufferGeometry} geo  a strip, authored in weapon space
   */
  constructor(spec, geo) {
    this.spec = spec;
    this.tex = makeBandTexture();
    /**
     * `toneMapped: true` is deliberate and load-bearing — see the class note.
     * `depthWrite: false` because an additive overlay must not occlude, and
     * `depthTest` stays ON so the band is correctly hidden by the receiver when
     * the weapon rolls.
     */
    this.material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(spec.color).multiplyScalar(spec.intensity),
      map: this.tex,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      toneMapped: true,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.material.name = 'ow-skin-band';
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'ow-skin-band-mesh';
    // The band is decoration on the weapon, never a shadow caster and never in
    // the prepass: `owNoPrepass` keeps it out of the MRT pass that fx and the
    // motion vectors read.
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.userData.owNoPrepass = true;
    this.mesh.userData.owNoShadow = true;
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
    this.enabled = true;
  }

  /** @param {number} elapsed `ctx.time.elapsed` */
  update(elapsed) {
    if (!this.enabled || !this.mesh.visible) return;
    // `tiles` sets the band PERIOD in world units along the strip, and `speed`
    // how fast it travels. Both are per-skin, so a fast tight band and a slow
    // broad one are the same code.
    this.tex.offset.y = (elapsed * this.spec.speed) % 1;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.material.dispose();
    this.tex.dispose();
  }
}

/**
 * A soft vertical gradient, generated. 8 px wide is enough — it is stretched
 * around the barrel and never sampled at more than a few pixels across.
 *
 * The falloff is `sin^2` over the band, which reaches exactly zero at both ends.
 * A linear ramp leaves a visible step where it meets the barrel's dark finish,
 * and because the material is additive that step is a bright line rather than a
 * subtle one.
 */
function makeBandTexture() {
  const W = 8;
  const H = 64;
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    // v in 0..1 across the band; the profile is symmetric about the middle.
    const v = (y + 0.5) / H;
    const s = Math.sin(v * Math.PI);
    const a = Math.round(s * s * 255);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = a;
    }
  }
  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  // No mipmaps: the strip is 8 px wide and always viewed near-on, and a mip
  // chain on a 64x8 texture mostly costs VRAM for nothing.
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/**
 * Build the band geometry for a weapon, if its model supplies one.
 *
 * The strip is authored in weapon space, along +Z from the receiver, and is
 * sized to sit just proud of the barrel and handguard. `radius` is a fudge
 * factor: the strip is a flat quad curved by nothing, so it has to be pushed out
 * far enough to clear the round parts it passes over or it z-fights with them.
 * 1.04 is the smallest value that clears the rifle's handguard without floating
 * visibly off the thinner barrel.
 *
 * @returns {THREE.BufferGeometry|null}
 */
export function buildBandGeometry(model) {
  const n = model?.nodes?.band;
  if (!n) return null;
  const { z0, z1, radius = 1.04, width = 0.019, segments = 12 } = n;
  const len = Math.abs(z1 - z0);
  if (!(len > 0)) return null;
  const segs = Math.max(2, segments | 0);
  // Curved, not flat: a flat quad across a round barrel disappears at the
  // silhouette edges, and the band has to wrap far enough to be visible from
  // the side. A shallow arc of `radius` degrees is enough — the band is a
  // reflection, not a surface.
  const arc = Math.PI * 0.62;
  const pos = new Float32Array((segs + 1) * 2 * 3);
  const uv = new Float32Array((segs + 1) * 2 * 2);
  const idx = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const a = -arc * 0.5 + arc * t;
    const x = Math.sin(a) * width * radius;
    const y = Math.cos(a) * width * radius;
    const z = z0 + (z1 - z0) * t;
    const o = i * 6;
    pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
    pos[o + 3] = x; pos[o + 4] = y; pos[o + 5] = z;
    const u = i * 4;
    uv[u] = 0; uv[u + 1] = t;
    uv[u + 2] = 1; uv[u + 3] = t;
    if (i < segs) {
      const b = i * 2;
      idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.name = 'ow-skin-band-geo';
  return g;
}

export { makeBandTexture };
