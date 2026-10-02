/**
 * WEAPON SKINS
 * =============
 * A skin is a MATERIAL SUBSTITUTION, not a texture. There are no image files in
 * this project — every surface is generated in code — so a "skin" is a remap of
 * the material keys a model asks for onto different entries in
 * `WEAPON_MATERIALS` (`materials.js`), which in turn are different bakes of the
 * same procedural surfaces.
 *
 * This is why skins are cheap here in a way they are not in a normal game: there
 * is no new art, no UV unwrap and no new bake pipeline. A camo skin is a
 * different baked `tint` and `wear` on the same surface, which costs one extra
 * material variant per remapped key and nothing else. The cost is VRAM and one
 * more program per variant, both of which `prewarmMaterials` already accounts
 * for.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE CONSTRAINT THAT SHAPES EVERY SKIN DEFINED HERE.
 *
 * `materials.js` documents a long, measured exposure recalibration: the
 * viewmodel light rig delivers roughly 20x the irradiance per unit albedo that
 * the world does, so every weapon albedo in that file is deliberately crushed to
 * about a THIRD of physical to compensate. Stock `alu` sits at 0.285 linear
 * where real black anodising is ~0.026-0.032, and that file is emphatic that
 * this is not a bug to be tidied up — it is what makes the gun diffuse-dominant
 * and therefore readable at all.
 *
 * A skin shipping a physically-plausible albedo therefore renders as a white
 * blob on this rig. Every `tint` in `materials.js` below is on the same crushed
 * scale as the stock materials, and the F0-bearing metals (`steel*`, which are
 * metalness 1) are moved far less than the dielectrics, because on a metal
 * `tint` is not an albedo at all. This is the easiest way to get a skin wrong
 * and it will not show up in any unit test — only in a screenshot.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * HOW A SKIN IS APPLIED
 *
 * A def carries `skinMats`, a `{ matKey -> matKey }` remap. The model still asks
 * for `'alu'`; `WeaponMaterials.get` resolves it to `'alu_desert'` when a skin is
 * active. Nothing in `models/` or `parts.js` knows skins exist.
 */

/**
 * `matKey -> variant key in WEAPON_MATERIALS`.
 *
 * Only keys a model actually requests need to appear. Omitting one means the
 * stock material is used, which is the right default for parts that should not
 * change — brass, copper, glass and the optic internals are deliberately absent
 * from every skin, because a gold shell or a blue lens would read as a mistake.
 */
export const SKINS = {
  /** The shipped appearance. Referenced by `?skin=` and by the pause menu. */
  issue: {
    id: 'issue',
    label: 'Issue Black',
    /** No remap: this IS the stock material set. */
    mats: {},
    desc: 'Hard-anodised black, as issued.',
  },

  /**
   * Flat Dark Earth — the classic arid patrol finish, and the skin where the hue
   * shift is the whole point. Everything goes warm and light.
   *
   * `polymer_tan` already exists in the stock library, so the furniture remap is
   * free. The receiver gets a genuinely new FDE-anodised variant rather than a
   * tint scale, because a receiver that is merely a lighter black reads as "clean
   * rifle" rather than as "painted for sand", and the FDE market is painted.
   */
  desert: {
    id: 'desert',
    label: 'Desert FDE',
    mats: {
      alu: 'alu_fde',
      alu_fine: 'alu_fde_fine',
      polymer: 'polymer_tan',
      rubber: 'rubber_tan',
    },
    desc: 'Flat dark earth over parkerised steel.',
  },

  /**
   * Arctic / maritime. Cold grey-blue, and the one skin where the receiver goes
   * LIGHTER than the furniture instead of darker — the inverse of every other
   * finish, which is what makes it read as a different weapon rather than as a
   * repaint of the same one.
   */
  arctic: {
    id: 'arctic',
    label: 'Arctic Grey',
    mats: {
      alu: 'alu_arctic',
      alu_fine: 'alu_arctic_fine',
      polymer: 'polymer_arctic',
      rubber: 'rubber_arctic',
    },
    desc: 'Cold grey. Receiver lighter than the furniture.',
  },

  /**
   * Urban camouflage: discrete blotches rather than a wash, aimed at the market
   * street this level is set in. The only skin with a real macro pattern instead
   * of a tint, which is what makes it the most expensive of the four to bake and
   * the most obvious on screen.
   *
   * `wear` is raised on the polymer deliberately: a camo that wears through to
   * bare bright metal reads as a pattern, whereas one that wears to flat grey
   * reads as dirt.
   */
  urban: {
    id: 'urban',
    label: 'Urban Camo',
    mats: {
      alu: 'alu_camo',
      alu_fine: 'alu_camo_fine',
      polymer: 'polymer_camo',
      rubber: 'rubber_camo',
    },
    desc: 'Blotched urban pattern. Wears to bare metal.',
  },

  /**
   * Cobalt. A saturated blue finish — an electrotype, so on the metals it is a
   * genuinely different F0 rather than a coloured lacquer over one.
   *
   * Included partly as a stress test: a saturated hue is the case most likely to
   * blow out on this rig, so it is the one that proves the crushed-albedo
   * discipline holds for a colour well away from neutral. It is also the
   * cheapest way to see whether a skin is actually applied.
   */
  cobalt: {
    id: 'cobalt',
    label: 'Cobalt',
    mats: {
      alu: 'alu_cobalt',
      alu_fine: 'alu_cobalt_fine',
      polymer: 'polymer_cobalt',
    },
    desc: 'Saturated blue hard anodise.',
  },

  /**
   * REACTIVE — a skin with a LIVE EFFECT rather than a static finish.
   *
   * The other four are material substitutions: bake a different tint, swap the
   * material, done. This one animates. The receiver carries a thin-film
   * interference layer (three's `iridescence`, the same term the optic glass
   * uses) whose thickness uniform is driven from `ctx.time` every frame, so the
   * colour walks across the metal as the weapon moves. It reads as an oil-slick
   * or DLC-style finish, and it is the reason `WeaponSystem` gained a
   * `setSkinEffect` path at all.
   *
   * WHY IT IS NOT FREE, and what it costs:
   *   - `iridescence` forces `MeshPhysicalMaterial` and adds a thin-film
   *     computation to every shaded pixel of the affected parts. On the receiver
   *     and rail that is a large screen area in hipfire framing.
   *   - It is a DIFFERENT program from the stock one, so it must be compiled by
   *     `weapons.prewarmMaterials` (it is — every skin is) or the first frame
   *     after the swap pays a compile stall.
   *   - Because it animates off `ctx.time`, it is DETERMINISTIC and therefore
   *     safe for the capture path. A skin driven off `performance.now()` would
   *     have quietly broken the pixel gate, which is the whole reason every
   *     animated thing in this project reads the engine clock.
   *
   * The drum is a two-part texture mask: a horizontal band that scrolls along
   * the barrel axis. `WEAPON_MATERIALS` can only express a static albedo, so
   * the band is a SEPARATE additive overlay mesh rather than a material — see
   * `skinFx` in `models/` for the geometry and `viewmodel.applySkin` for the
   * swap.
   */
  reactive: {
    id: 'reactive',
    label: 'Reactive',
    mats: {
      alu: 'alu_reactive',
      alu_fine: 'alu_reactive_fine',
      polymer: 'polymer_cobalt',
    },
    /** Non-null: this skin has a live effect. See `SkinEffect` in index.js. */
    effect: {
      kind: 'iridescence',
      /** nm. The visible range for a thin film; see `iridescenceThicknessRange`. */
      min: 220,
      max: 620,
      /** Seconds for one full sweep of the thickness range. */
      period: 7.5,
    },
    /** Scrolling band on the barrel/handguard. See `SkinFx` in models/skinfx.js. */
    band: { color: 0x7fe8ff, intensity: 1.35, speed: 0.34, tiles: 5.5 },
    desc: 'Oil-slick. Shifts colour as you move.',
  },

  /**
   * GOLD — the other live-effect skin, and deliberately the OPPOSITE failure mode
   * to `reactive`.
   *
   * A polished precious-metal finish: the metals go to a real gold F0 and the
   * roughness drops hard, so they read as polished rather than anodised. It is
   * physically far too reflective for a working weapon, which is exactly the
   * point — it is a cosmetic flex, and the comments in the material entries
   * explain why the value is capped despite being a metal (a metal's `tint` is
   * F0, and an unconstrained one blows out on this rig far faster than a
   * dielectric's albedo does).
   *
   * The effect is a slow specular sweep rather than a colour shift: the
   * iridescence term runs at a much lower amplitude and a longer period, so the
   * gold stays gold and only the highlight travels.
   */
  gold: {
    id: 'gold',
    label: 'Gold',
    mats: {
      alu: 'alu_gold',
      alu_fine: 'alu_gold_fine',
      polymer: 'polymer_cobalt',
    },
    effect: {
      kind: 'iridescence',
      // A NARROW band near the short end of the visible range, so the hue swing
      // is a subtle oil-on-gold rather than an oil-slick. Wide range here would
      // turn the gold green and blue and stop reading as gold at all.
      min: 280,
      max: 360,
      period: 14,
      amplitude: 0.35,
    },
    band: { color: 0xffd98a, intensity: 0.85, speed: 0.19, tiles: 4 },
    desc: 'Polished gold with a travelling highlight.',
  },

  /**
   * FOREST GREEN — the colour family the range was missing until now (black,
   * sand, arctic grey, urban camo and blue existed; green did not). A dark
   * satin anodise with the furniture a shade deeper, so the receiver reads
   * lighter than the stock — the same inversion trick `arctic` uses.
   */
  verdant: {
    id: 'verdant',
    label: 'Forest Green',
    mats: {
      alu: 'alu_verdant',
      alu_fine: 'alu_verdant_fine',
      polymer: 'polymer_verdant',
    },
    desc: 'Satin forest green anodise.',
  },

  /**
   * ASH — pale gunmetal sanded down to bare bright metal. The wear showcase of
   * the range and the looking-glass of the others: where cobalt is dark and
   * clean, ash is light and beaten. Highest wear amplitude and the brightest
   * wear colour in the set, on a receiver already lighter than any other skin.
   */
  ash: {
    id: 'ash',
    label: 'Battle-Worn Ash',
    mats: {
      alu: 'alu_ash',
      alu_fine: 'alu_ash_fine',
      polymer: 'polymer_ash',
    },
    desc: 'Pale gunmetal, sanded to bright wear.',
  },
};

/** Skin ids in menu order. `issue` first — it is the shipped look. */
export const SKIN_IDS = Object.keys(SKINS);

/**
 * Fold a skin into a weapon def, returning a NEW def.
 *
 * Copies rather than mutates, because `WEAPON_DEFS` is a module-level singleton
 * shared by every weapon instance, the capture harness and the preview page.
 * Mutating it would make skin selection global and load-order-dependent — the
 * classic way a cosmetic option becomes a state-corruption bug.
 *
 * @param {object} def      a def, or a copy of one
 * @param {string|null} skinId
 * @returns {object} a def carrying `skin` and `skinMats`
 */
export function resolveSkin(def, skinId) {
  const out = { ...def };
  if (!skinId) {
    out.skin = 'issue';
    out.skinMats = null;
    out.skinEffect = null;
    out.skinBand = null;
    return out;
  }
  const skin = SKINS[skinId];
  if (!skin) {
    // A bad `?skin=` must not break the page. Warn and fall back to stock, rather
    // than rendering a gun with an unmapped material key.
    console.warn(`[weapons] unknown skin "${skinId}" — falling back to "issue"`);
    out.skin = 'issue';
    out.skinMats = null;
    out.skinEffect = null;
    out.skinBand = null;
    return out;
  }
  out.skin = skin.id;
  out.skinLabel = skin.label;
  // Null for the stock skin so `WeaponMaterials` skips the indirection entirely
  // on the default path — a map lookup per material per frame would be silly,
  // and the default path is the one the pixel gate photographs.
  out.skinMats = skin.mats && Object.keys(skin.mats).length ? { ...skin.mats } : null;
  /**
   * The live effect descriptor, or null. Copied rather than referenced for the
   * same reason `skinMats` is: `WEAPON_DEFS` is a module singleton and a shared
   * mutable object would let one weapon's effect state leak into another's.
   */
  out.skinEffect = skin.effect ? { ...skin.effect } : null;
  out.skinBand = skin.band ? { ...skin.band } : null;
  return out;
}
