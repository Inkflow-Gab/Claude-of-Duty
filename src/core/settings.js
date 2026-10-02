/**
 * Persistent settings.
 *
 * WHY THIS IS NOT IN THE MENU. The pause menu already reaches `config` and
 * `weapons` directly, so the obvious place to save is "in the menu". That would
 * mean every future control has to remember to write to storage, and every one
 * that forgets silently loses the player's choice on reload. Instead, storage is
 * a *transport* and each subsystem keeps its own schema: the menu still calls
 * `config.setQuality(...)`, the store observes, and nothing new is needed to make
 * a control persistent.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY NOT PERSISTED
 *
 *   quality     the auto-detected tier is re-derived every boot. A player who
 *               first launched on Wi-Fi and got `low`, then moved to a desk with
 *               a monitor, should get the better preset on the next run without
 *               having to remember a menu existed. An explicit override is
 *               honoured (see `qualityOverride`) but the default is not sticky.
 *   touch       re-derived from the device, and a hybrid laptop can be either.
 *   FOV         a phone and a desktop have very different ideas of a
 *               comfortable FOV; carrying one across devices is worse than
 *               re-deriving. The default is per-device for the same reason.
 *
 * Everything else — sensitivity, skin, invert, audio — is the player's own
 * choice about how THEY play, and that should survive a reload on any device.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * STORAGE CHOICE. `localStorage`, accessed defensively.
 *
 * It throws in more situations than people expect: Safari private browsing, a
 * `file://` origin, an iframe with third-party storage blocked, and quota
 * exhaustion after a few hundred failed writes. Every access is wrapped, and the
 * whole module degrades to a no-op in-memory shim rather than taking boot down —
 * a settings system that can prevent the game from starting is strictly worse
 * than one that forgets.
 *
 * `SCHEMA_VERSION` is checked on read. Without it, a renamed or removed key
 * resurrects a stale value from an older build and the bug is invisible.
 */

const KEY = 'black-of-duty.settings.v1';
const SCHEMA_VERSION = 1;

/** Fields we persist, and their type. Anything not listed here is not saved. */
const FIELDS = {
  sensitivity: 'number',
  invertY: 'boolean',
  skin: 'string',
  /** Explicit player override of the auto-detected tier. */
  qualityOverride: 'string',
  masterVolume: 'number',
};

/** Backend, or a no-op shim when storage is unavailable. */
function makeStore() {
  try {
    const ls = globalThis.localStorage;
    // A write probe, because Safari exposes the object but throws on setItem.
    const probe = '__ow_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    console.warn('[settings] localStorage unavailable — settings will not persist');
    const mem = new Map();
    return {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, v),
      removeItem: (k) => mem.delete(k),
    };
  }
}

export class Settings {
  constructor(config) {
    this.config = config;
    this.store = makeStore();
    /** Last known values, so a save can be a diff against them. */
    this._last = {};
    /** Cached read, so `peek()` and `load()` agree and storage is hit once. */
    this._loaded = null;
    this.available = this.store !== null;
  }

  /**
   * The settings as last read or written, WITHOUT touching `config`.
   *
   * This is what a subsystem wants when it needs a value it does not own and does
   * not want applied globally. `weapons` uses it for the saved skin: it has to
   * know the value before it builds anything, and routing the skin through
   * `load()` would mean `weapons` mutating a field it has no business owning.
   *
   * Reads storage on first call, so a caller that runs before `load()` still sees
   * the persisted values rather than an empty object.
   */
  peek() {
    if (!this._loaded) {
      this._loaded = this._read() ?? {};
      this._last = { ...this._loaded };
    }
    return this._loaded;
  }

  /**
   * Read persisted settings and apply them to `config`.
   *
   * Called once, immediately after `createConfig` and BEFORE any subsystem
   * initialises — the quality override in particular has to be known before
   * `render` snapshots `cfg.q`.
   *
   * @returns {object} the raw settings object, for subsystems that keep their own
   */
  load() {
    const raw = this._read();
    this._loaded = raw ?? {};
    if (!raw) return {};
    this._last = { ...raw };
    const cfg = this.config;
    /**
     * Applied in a fixed order, and every one is clamped. A hand-edited or
     * corrupt store must not be able to produce an unplayable config: sensitivity
     * of 0 or a negative volume are both silently-accepted by plain assignment.
     */
    if (typeof raw.sensitivity === 'number' && Number.isFinite(raw.sensitivity)) {
      cfg.sensitivity = clamp(raw.sensitivity, 0.0002, 0.02);
    }
    if (typeof raw.invertY === 'boolean') cfg.invertY = raw.invertY;
    if (typeof raw.qualityOverride === 'string' && raw.qualityOverride) {
      // Only applied if it is a real preset; an unknown name in storage must not
      // throw inside createConfig's setQuality.
      try {
        cfg.setQuality(raw.qualityOverride);
        cfg.qualityPinned = true;
      } catch {
        console.warn(`[settings] ignoring unknown quality override "${raw.qualityOverride}"`);
      }
    }
    if (typeof raw.masterVolume === 'number' && Number.isFinite(raw.masterVolume)) {
      cfg.masterVolume = clamp(raw.masterVolume, 0, 1);
    }
    return raw;
  }

  _read() {
    let text;
    try {
      text = this.store.getItem(KEY);
    } catch {
      return null;
    }
    if (!text) return null;
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      // Corrupt JSON. Drop it rather than leaving it to fail on every boot.
      this._clear();
      return null;
    }
    if (!obj || typeof obj !== 'object') return null;
    if (obj.v !== SCHEMA_VERSION) {
      // Wrong shape for this build. Discard rather than guess.
      this._clear();
      return null;
    }
    return obj.s ?? null;
  }

  /** Merge a partial update and write. Returns false if nothing was stored. */
  save(patch) {
    if (!patch || typeof patch !== 'object') return false;
    const next = { ...this._last };
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (next[k] === v) continue;
      next[k] = v;
      changed = true;
    }
    if (!changed) return true;
    this._last = next;
    this._loaded = next;
    return this._write(next);
  }

  _write(obj) {
    try {
      this.store.setItem(KEY, JSON.stringify({ v: SCHEMA_VERSION, s: obj }));
      return true;
    } catch (err) {
      // Quota exceeded, or storage revoked mid-session. Not fatal: the setting
      // still applies for this session, it just will not survive a reload.
      console.warn('[settings] could not persist:', err?.name ?? err);
      return false;
    }
  }

  _clear() {
    try {
      this.store.removeItem(KEY);
    } catch {
      /* nothing to do */
    }
  }

  /** Wipe stored settings. Wired to the menu's Defaults button. */
  reset() {
    this._clear();
    this._last = {};
    this._loaded = {};
  }

  /**
   * Observe a change and persist it.
   *
   * Called by subsystems after they mutate a field, so no control has to know
   * that persistence exists. Cheap enough to call on every slider `input` event
   * because the diff means an unchanged value never touches storage.
   */
  observe(patch) {
    return this.save(patch);
  }

  /**
   * Validate and coerce a value for a known field.
   *
   * Exposed so a subsystem writing a skin id or a quality name cannot put an
   * arbitrary string into storage; `load` sanitises on the way in, and this
   * sanitises on the way out.
   */
  static sanitize(field, value) {
    const type = FIELDS[field];
    if (!type) return undefined;
    if (type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
      return value;
    }
    if (type === 'boolean') return typeof value === 'boolean' ? value : undefined;
    if (type === 'string') return typeof value === 'string' && value ? value : undefined;
    return undefined;
  }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export { KEY as SETTINGS_KEY, SCHEMA_VERSION };
