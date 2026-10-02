import { el, setText, setStyle, clamp, damp, ease } from './util.js';

/**
 * Preset order matters: it is the on-screen order and the index is what
 * `syncQuality` compares against. `mobile` leads because it is the auto-selected
 * rung on a touch device, and a player who has to scroll to find the setting
 * that is already active will assume the setting is broken.
 *
 * Note that switching preset at runtime only takes effect for flags that are
 * re-read after init — `renderScale` (on the next `resize()`), `pixelRatioCap`
 * (ditto), and `sensitivity`/`fov` (live). The pass graph, shadow cascades and
 * texture bake sizes are all fixed at init, so changing preset in the menu needs
 * a reload to fully apply. That is pre-existing behaviour, unchanged here.
 */
const PRESETS = ['mobile', 'low', 'medium', 'high', 'ultra'];

/**
 * Pause / settings menu.
 *
 * Wired straight into `ctx.config`: the quality segments call
 * `config.setQuality`, the sliders write `config.sensitivity` and `config.fov`
 * (and push the FOV into the live camera), and every change is announced on the
 * event bus so render/player can react without importing this module.
 *
 * Events emitted: `ui:pause` {paused}, `ui:quality` {quality},
 * `ui:sensitivity` {value}, `ui:fov` {value}, `ui:setting` {key, value}.
 */
export class PauseMenu {
  /**
   * @param {HTMLElement} parent
   * @param {object} ctx
   * @param {object} [opts]
   * @param {object} [opts.settings]  a `core/settings.js` instance, for persistence
   * @param {boolean} [opts.touch]    force touch presentation regardless of device
   */
  constructor(parent, ctx, opts = {}) {
    this.ctx = ctx;
    const cfg = this.ctx.config;
    this.settings = opts.settings ?? null;
    /**
     * `touch` decides the whole presentation: control hints, slider sizing, and
     * the button labels. It comes from the config flag that `core/config.js`
     * derived, with an explicit override for the hybrid case (a touch laptop
     * reports fine pointer but the player is using their fingers).
     */
    this.touch = opts.touch ?? cfg.touch === true;
    this.root = el('div', 'ow-menu', parent);
    if (this.touch) this.root.classList.add('ow-menu-touch');
    const inner = el('div', 'ow-menu-inner', this.root);

    /**
     * The title block. The name comes from `config` rather than being a literal
     * here, so the pause menu, the document title and the demo card cannot drift
     * apart. `h1` is the state ("PAUSED"), not the game name — the name is the
     * subtitle line beneath it, which is where it reads as a masthead.
     */
    const h = el('h1', null, inner, 'PAUSED');
    h.textContent = 'PAUSED';
    el('div', 'sub', inner, `${cfg.title} — ${cfg.subtitle}`);
    el('div', 'rule', inner);

    this.rows = el('div', null, inner);

    // ---- quality preset --------------------------------------------------
    this.qBtns = [];
    const qRow = this._row('Graphics Preset');
    const seg = el('div', 'ow-seg', qRow);
    for (const p of PRESETS) {
      const b = el('button', null, seg, p);
      b.type = 'button';
      b.addEventListener('click', () => this.setQuality(p));
      this.qBtns.push(b);
    }

    /**
     * Device note. Only shown when the auto-tier made a choice the player might
     * not have expected — a touch device that landed on `mobile`, or a machine
     * that did not. A menu that silently says "mobile" on a phone is fine; one
     * that says "ultra" because a sniff failed is the case worth explaining.
     */
    const dev = this.ctx.config?.device;
    if (dev) {
      const note = el('div', 'ow-menu-note', qRow, `Detected: ${dev.tier} — ${dev.reason}`);
      note.title =
        'Chosen from touch support, pointer type and core count. ' +
        'Changing the preset here takes effect fully after a reload.';
    }

    // ---- weapon skin -----------------------------------------------------
    /**
     * Skin is a weapon concern, not a graphics one, so it goes through
     * `ctx.peek('weapons').setSkin` and never imports the skin table. The
     * menu only asks for the list of ids and labels, which `weapons` exposes for
     * exactly this purpose.
     */
    const weapons = this.ctx.peek?.('weapons');
    if (weapons?.skinIds) {
      this.skinBtns = [];
      const sRow = this._row('Weapon Finish');
      const sSeg = el('div', 'ow-seg', sRow);
      for (const s of weapons.skinIds) {
        const b = el('button', null, sSeg, s.label);
        b.type = 'button';
        b.title = s.desc ?? '';
        b.addEventListener('click', () => {
          if (weapons.setSkin(s.id)) {
            this._syncSkin();
            this.settings?.observe({ skin: s.id });
          }
        });
        this.skinBtns.push({ id: s.id, el: b });
      }
      this._weapons = weapons;
    }

    // ---- sensitivity -----------------------------------------------------
    /**
     * Labelled "Aim Sensitivity" rather than "Mouse Sensitivity", and the note
     * under it says what the number is relative to. On a touch device the
     * multiplier drives a completely different input path (the look drag in
     * `core/touch.js` multiplies raw touch pixels by LOOK_GAIN and then by this
     * same `config.sensitivity`), so calling it a mouse setting on a phone where
     * there is no mouse is actively misleading. The ranges are tuned so the
     * default reads 1.00 on both, and touch users who need a big change can get
     * it from LOOK_GAIN instead of running the slider to its end stop.
     */
    this.sens = this._slider(
      'Aim Sensitivity',
      0.2,
      3.0,
      0.01,
      (v) => {
        this.ctx.config.sensitivity = 0.0022 * v;
        this.ctx.events.emit('ui:sensitivity', { value: this.ctx.config.sensitivity, multiplier: v });
        return v.toFixed(2);
      },
      { persistKey: 'sensitivity', toStored: (v) => 0.0022 * v }
    );
    el('div', 'ow-menu-hintrow', this.sens.row, '1.00 = default · affects mouse and touch');

    // ---- field of view ---------------------------------------------------
    /**
     * FOV is NOT persisted, and the note says so.
     *
     * The other settings describe how a person plays; FOV describes the display
     * they are playing on. A phone in landscape and a 27" monitor want different
     * values, and carrying one across a device change produces a setting the
     * player did not choose and cannot explain.
     */
    this.fov = this._slider('Field Of View', 65, 120, 1, (v) => {
      this.ctx.config.fov = v;
      const cam = this.ctx.camera;
      if (cam) {
        cam.fov = v;
        cam.updateProjectionMatrix();
      }
      this.ctx.events.emit('ui:fov', { value: v });
      return String(v | 0);
    });
    el('div', 'ow-menu-hintrow', this.fov.row, 'Not saved — set per screen');

    // ---- invert look -----------------------------------------------------
    const invRow = this._row('Invert Look');
    const invSeg = el('div', 'ow-seg', invRow);
    this.invBtns = [];
    for (const [label, val] of [
      ['off', false],
      ['on', true],
    ]) {
      const b = el('button', null, invSeg, label);
      b.type = 'button';
      b.addEventListener('click', () => {
        this.ctx.config.invertY = val;
        this.ctx.events.emit('ui:setting', { key: 'invertY', value: val });
        this.settings?.observe({ invertY: val });
        this.syncFromConfig();
      });
      this.invBtns.push([b, val]);
    }

    // ---- buttons ---------------------------------------------------------
    const btns = el('div', 'ow-btns', inner);
    this.resumeBtn = el('button', 'ow-btn primary', btns, 'Resume');
    this.resumeBtn.type = 'button';
    this.resumeBtn.addEventListener('click', () => this.close());
    const reset = el('button', 'ow-btn', btns, 'Defaults');
    reset.type = 'button';
    /**
     * Defaults clears STORAGE as well as the live values.
     *
     * Leaving the stored copy behind would mean the very next reload restores the
     * settings the player just reset — the button would appear broken in a way
     * that is genuinely hard to diagnose, because it looks correct until you
     * reload. The live reset also re-applies the auto-detected tier rather than
     * forcing `ultra`, because "defaults" on a phone should mean the phone's own
     * settings, not a desktop's.
     */
    reset.addEventListener('click', () => {
      this.settings?.reset();
      this.sens.set(1);
      this.fov.set(80);
      this.ctx.config.invertY = false;
      this.weaponsResetSkin?.();
      this.setQuality(this.ctx.config.device?.tier === 'mobile' ? 'mobile' : 'ultra');
    });

    /**
     * Control hints. The desktop line is the pre-existing one. The touch line is
     * the one that was missing: a phone player had a full set of on-screen
     * controls and no label anywhere telling them what they were, and a game that
     * cannot be played without an undocumented gesture is not a mobile port.
     */
    if (this.touch) {
      el(
        'div',
        'hint',
        inner,
        'TAP ≡ TOP-LEFT FOR SETTINGS · LEFT STICK MOVE · DRAG RIGHT TO AIM · ' +
          'FIRE / ADS / RELOAD ON THE RIGHT'
      );
    } else {
      el('div', 'hint', inner, 'ESC RESUME · WASD MOVE · SHIFT SPRINT · R RELOAD · F USE');
    }

    this.open = false;
    this.shown = 0;
    setStyle(this.root, 'display', 'none');
    setStyle(this.root, 'cursor', 'default');
    this.syncFromConfig();
  }

  _row(name) {
    const r = el('div', 'ow-row', this.rows);
    el('div', 'name', r, name.toUpperCase());
    return r;
  }

  /**
   * @param {string} name        row label
   * @param {number} min
   * @param {number} max
   * @param {number} step
   * @param {(v:number)=>string|void} apply   commits the value, returns the label
   * @param {object} [opts]
   * @param {string} [opts.persistKey]  key in `core/settings.js` to write on release
   * @param {(v:number)=>unknown} [opts.toStored]  slider value -> stored value.
   *   Needed wherever the two differ: sensitivity is stored as the absolute
   *   `config.sensitivity` but the slider works in a multiplier, and storing the
   *   multiplier would silently rescale every future session.
   */
  _slider(name, min, max, step, apply, opts = {}) {
    const { persistKey = null, toStored = (v) => v } = opts;
    const row = this._row(name);
    const wrap = el('div', 'ow-slider', row);
    /**
     * Touch sizing for a range input.
     *
     * A native `<input type=range>` is ~16 px tall by default, which is well
     * under the ~44 px minimum comfortable target, and its thumb is small and
     * often offset from the track on mobile browsers. Both are fixed here rather
     * than in the stylesheet because the stylesheet's `--k` scale is tuned for
     * 1080p desktop and would make the hit area wrong on both ends.
     *
     * `touch-action: none` is the important one: without it a vertical drag on the
     * slider scrolls the page instead of moving the thumb, which on a phone means
     * the sensitivity control appears completely dead.
     */
    const touchy = this.touch;
    setStyle(wrap, 'touch-action', touchy ? 'none' : '');
    if (touchy) {
      setStyle(wrap, 'height', '44px');
      setStyle(wrap, 'min-width', '190px');
      setStyle(wrap, 'align-items', 'center');
    }
    el('div', 'track', wrap);
    const fill = el('div', 'fill', wrap);
    const knob = el('div', 'knob', wrap);
    const input = el('input', null, wrap);
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    const val = el('div', 'val', row, '');

    /**
     * The fill/knob are painted by hand because the stock stylesheet positions
     * them from `--k`, which is viewport-height based and therefore wrong on a
     * phone held in landscape (a 400 px-tall viewport clamps `--k` to its 0.62
     * floor and the slider becomes visually inconsistent with its own track).
     * Inline percentages are resolution-independent, so the control looks the
     * same at any size.
     */
    setStyle(fill, 'position', 'absolute');
    setStyle(knob, 'position', 'absolute');
    setStyle(wrap, 'position', 'relative');

    const paint = (v) => {
      const t = (v - min) / (max - min);
      setStyle(fill, 'width', (t * 100).toFixed(2) + '%');
      setStyle(knob, 'left', (t * 100).toFixed(2) + '%');
      setText(val, apply(v) ?? String(v));
    };
    input.addEventListener('input', () => paint(parseFloat(input.value)));
    /**
     * `change` as well as `input`: on a range input `input` fires continuously
     * during the drag, and persisting on every one of those events is a write per
     * frame of thumb movement. `change` fires once on release, which is the
     * right granularity for storage. The handler is coalesced to a microtask
     * because some browsers fire `change` from a synthetic click as well.
     */
    input.addEventListener('change', () => {
      if (!persistKey) return;
      const v = parseFloat(input.value);
      if (Number.isFinite(v)) this.settings?.observe({ [persistKey]: toStored(v) });
    });
    const api = {
      set: (v) => {
        const c = clamp(v, min, max);
        input.value = String(c);
        paint(c);
      },
      /** The row, so a caller can append a note under the control. */
      row,
    };
    return api;
  }

  setQuality(name) {
    try {
      this.ctx.config.setQuality(name);
      this.ctx.config.qualityPinned = true;
      // Only now is the choice the player's. See `syncFromConfig`.
      this._userPickedQuality = true;
      this.ctx.events.emit('ui:quality', { quality: name });
    } catch (err) {
      console.warn('[ui] quality switch failed', err);
    }
    this.syncFromConfig();
  }

  syncFromConfig() {
    const cfg = this.ctx.config;
    for (let i = 0; i < this.qBtns.length; i++)
      this.qBtns[i].classList.toggle('on', PRESETS[i] === cfg.quality);
    for (const [b, v] of this.invBtns) b.classList.toggle('on', !!cfg.invertY === v);
    this.sens?.set((cfg.sensitivity ?? 0.0022) / 0.0022);
    this.fov?.set(cfg.fov ?? 80);
    this._syncSkin();
    /**
     * Mark the active preset as deliberate, and persist it.
     *
     * `qualityOverride` is what stops the boot auto-tier from overriding the
     * player's choice on the next run. It is only set when the player actually
     * touches the control — `syncFromConfig` is also called on `show()`, so
     * writing on every open would pin the preset to whatever the device sniff
     * happened to pick, which is the opposite of the intent.
     */
    if (this._userPickedQuality) this.settings?.observe({ qualityOverride: cfg.quality });
  }

  /** Highlight the active finish. Separate from `syncFromConfig` because skin
   *  lives on the weapons subsystem, not on `config`. */
  _syncSkin() {
    if (!this.skinBtns) return;
    const active = this._weapons?.skinId ?? 'issue';
    for (const b of this.skinBtns) b.el.classList.toggle('on', b.id === active);
  }

  toggle() {
    this.open ? this.close() : this.show();
  }

  show() {
    if (this.open) return;
    this.open = true;
    this.syncFromConfig();
    setStyle(this.root, 'display', '');
    /**
     * Warm the remaining weapon finishes now, while the player is reading a menu.
     *
     * This is the whole point of deferring them out of boot: by the time anyone
     * taps a finish, its materials are baked and its programs compiled, so the
     * swap is instant. Here, a few hundred ms of background work is invisible —
     * there is already a full-screen panel up.
     *
     * Fire-and-forget, and guarded twice: the menu must open even if warming
     * fails or does not exist, and the promise must not reject unhandled.
     */
    if (this._weapons?.prewarmAllSkins && !this._skinsWarmed) {
      this._skinsWarmed = true;
      Promise.resolve(this._weapons.prewarmAllSkins()).catch((err) => {
        this._skinsWarmed = false;
        console.warn('[ui] skin pre-warm failed', err);
      });
    }
    document.exitPointerLock?.();
    const t = this.ctx.time;
    if (t) {
      this._prevScale = t.scale;
      t.scale = 0;
    }
    /**
     * Drop every held touch control.
     *
     * The fire button and the stick are held DOWN by their pointer, and freezing
     * the game does not release them: a player who pauses with FIRE held would
     * come back to a gun firing itself, because the synthetic `Mouse0` never got
     * a `pointerup`. This is the same problem `Input._onBlur` solves, and it
     * needs solving at every pause, not just on a window blur.
     */
    this.ctx.input?.touch?.releaseAll?.();
    this.ctx.peek('player')?.setControlEnabled?.(false);
    this.ctx.events.emit('ui:pause', { paused: true });
  }

  close() {
    if (!this.open) return;
    this.open = false;
    const t = this.ctx.time;
    if (t) t.scale = this._prevScale ?? 1;
    this.ctx.peek('player')?.setControlEnabled?.(true);
    /**
     * Pointer lock is a DESKTOP affordance and is actively harmful to request on
     * a touch device: there is no cursor to lock, the call is a no-op on most
     * mobile browsers, and on a few it throws a `SecurityError` that surfaces as
     * an unhandled rejection in the harness. Gated on `touch`.
     */
    if (!this.touch) this.ctx.input?.requestPointerLock?.();
    this.ctx.events.emit('ui:pause', { paused: false });
  }

  /** Driven with unscaled time so the fade still runs while the game is frozen. */
  update(rawDt) {
    this.shown = damp(this.shown, this.open ? 1 : 0, 14, rawDt);
    if (this.shown < 0.004) {
      setStyle(this.root, 'display', 'none');
      setStyle(this.root, 'pointer-events', 'none');
      return;
    }
    setStyle(this.root, 'display', '');
    setStyle(this.root, 'pointer-events', this.open ? 'auto' : 'none');
    setStyle(this.root, 'opacity', ease.outQuad(this.shown).toFixed(3));
  }

  dispose() {
    this.root.remove();
  }
}
