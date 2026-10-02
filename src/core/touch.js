/**
 * Touch controls.
 *
 * WHY THIS EXISTS. The game was pointer-lock-and-keyboard only, which is not a
 * usable input scheme on a phone: there is no cursor to lock, no right mouse
 * button, and no physical keys. A mobile tier that only reduced the pixel count
 * would boot and render but be unplayable, so this is not optional decoration
 * on top of the `mobile` preset — it is half of what makes that preset mean
 * anything.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE ONE DESIGN CONSTRAINT: this file speaks the SAME vocabulary as Input.
 *
 * Nothing downstream knows touch exists. There is no `input.isTouch`, no second
 * control path in `weapons` or `player`, no alternate movement branch. The stick
 * presses the same `KeyW` that a keyboard would, the fire button holds the same
 * `Mouse0`, and the look drag writes the same `movementX/Y` accumulator. That
 * means the touch scheme inherits the entire existing behaviour for free —
 * recoil, spread, sprint, crouch, mantling, weapon swapping, the fire-mode
 * state machine — with no duplication to keep in sync, and it is why this could
 * be added without touching a single other subsystem.
 *
 * It also means the rules that protect capture determinism are preserved for
 * free: `frozen` input zeroes the look delta, and the edge queries
 * (`pressed`/`released`) resolve to the same one-frame transitions.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * LAYOUT. Standard twin-stick shooter convention, thumb-first:
 *
 *   left third    floating movement stick — spawns wherever the thumb lands
 *   right half    look drag, anywhere (the gun is not a button, it is a swipe)
 *   bottom right  FIRE, large, under the thumb
 *   left of FIRE  ADS
 *   top right     reload, jump, crouch, sprint, swap
 *
 * Controls are DOM, not canvas-drawn, and they ride in `#ui` alongside the HUD:
 * they need to survive the same CSS transform budget as everything else and they
 * get browser hit-testing and accessibility for free. Nothing here draws into
 * the WebGL context, so it costs no draw calls.
 */

/**
 * Every button: label, the key code it synthesises, and its screen position.
 *
 * `MENU` is not a gameplay control and is handled separately below — it needs a
 * click rather than a held key, and it must reach the pause menu rather than
 * `Input`. It is listed here so it shares the layout pass and the scaling, and
 * flagged `latch` so `_onDown` treats it as a toggle rather than a hold.
 */
const BUTTONS = [
  { id: 'fire', label: 'FIRE', code: 'Mouse0', side: 'right', grow: 1.9, primary: true },
  { id: 'ads', label: 'ADS', code: 'Mouse2', side: 'right', grow: 1.35 },
  { id: 'reload', label: 'RELOAD', code: 'KeyR', side: 'right', grow: 1.05 },
  { id: 'swap', label: 'SWAP', code: 'Tab', side: 'right', grow: 1.0 },
  { id: 'jump', label: 'JUMP', code: 'Space', side: 'left', grow: 1.05 },
  { id: 'crouch', label: 'CROUCH', code: 'ControlLeft', side: 'left', grow: 1.0 },
  { id: 'sprint', label: 'SPRINT', code: 'ShiftLeft', side: 'left', grow: 1.0 },
  // Top-left, out of the thumb arcs. Deliberately small and deliberately NOT in
  // either cluster: a mistap here pauses the game, and a large button in the
  // movement zone would be hit constantly while strafing.
  { id: 'menu', label: '≡', code: null, side: 'top', grow: 0.86, latch: true },
];

/** Movement stick travel, in CSS px, at the reference viewport height. */
const STICK_RADIUS = 62;
/** Fraction of the viewport height the button scale is derived from (1080 == 1). */
const UI_SCALE_AT = 1080;

export class TouchControls {
  /**
   * @param {HTMLElement} layer  a positioned container; normally `#ui`
   * @param {Input} input         the Input instance to synthesise into
   * @param {object} opts         { scale, onFireMode, onSwap }
   */
  constructor(layer, input, opts = {}) {
    this.input = input;
    this.enabled = false;
    this.onFireMode = opts.onFireMode ?? null;
    this.onSwap = opts.onSwap ?? null;

    this.root = document.createElement('div');
    this.root.className = 'ow-touch';
    this.root.style.cssText = [
      'position:absolute', 'inset:0', 'z-index:6',
      // The whole layer must not eat taps meant for the canvas, but its
      // children deliberately do — that is the entire mechanism.
      'pointer-events:none', 'touch-action:none', 'user-select:none',
      '-webkit-user-select:none', '-webkit-tap-highlight-color:transparent',
      'font:inherit', 'color:inherit',
    ].join(';');
    layer.appendChild(this.root);

    this._buildStick();
    this._buildButtons();

    this._onResize = () => this._applyScale();
    addEventListener('resize', this._onResize);
    addEventListener('orientationchange', this._onResize);
    this._applyScale();

    // Active pointers, keyed by pointerId. Multi-touch is mandatory here, not a
    // nicety: moving, looking and firing have to be simultaneous or the game is
    // unplayable, and a single-touch implementation cannot express that.
    /** @type {Map<number, {role:string, ...}>} */
    this._pointers = new Map();
    this._bound = [];
    this._listen(this.root, 'pointerdown', this._onDown, { passive: false });
    this._listen(this.root, 'pointermove', this._onMove, { passive: false });
    this._listen(this.root, 'pointerup', this._onUp, { passive: false });
    this._listen(this.root, 'pointercancel', this._onUp, { passive: false });
    this._listen(this.root, 'contextmenu', this._onContextMenu, { passive: false });
  }

  _listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this._bound.push([target, type, fn]);
  }

  _buildStick() {
    const wrap = document.createElement('div');
    wrap.className = 'ow-stick';
    wrap.style.cssText = [
      'position:absolute', 'left:0', 'top:0',
      'width:calc(150px * var(--ts))', 'height:calc(150px * var(--ts))',
      'border-radius:50%', 'pointer-events:none', 'opacity:0',
      'transition:opacity .12s linear',
      'border:calc(2px * var(--ts)) solid rgba(238,244,247,.22)',
      'background:radial-gradient(circle,rgba(0,0,0,.18),rgba(0,0,0,.05) 70%,transparent 72%)',
    ].join(';');

    const knob = document.createElement('div');
    knob.className = 'ow-stick-knob';
    knob.style.cssText = [
      'position:absolute', 'left:50%', 'top:50%',
      'width:calc(58px * var(--ts))', 'height:calc(58px * var(--ts))',
      'margin:calc(-29px * var(--ts)) 0 0 calc(-29px * var(--ts))',
      'border-radius:50%', 'background:rgba(238,244,247,.30)',
      'box-shadow:0 0 calc(14px * var(--ts)) rgba(0,0,0,.45)',
    ].join(';');

    wrap.appendChild(knob);
    this.root.appendChild(wrap);
    this._stick = wrap;
    this._knob = knob;
  }

  _buildButtons() {
    this.buttons = new Map();
    for (const b of BUTTONS) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `ow-tbtn ow-tbtn-${b.id}`;
      el.textContent = b.label;
      el.dataset.code = b.code ?? '';
      el.dataset.id = b.id;
      el.style.cssText = [
        'position:absolute',
        'display:grid', 'place-items:center',
        'border-radius:50%',
        // A thumb is ~45 px across; nothing tappable goes below half that in
        // either dimension once the label is inside it.
        'min-width:calc(74px * var(--ts))', 'min-height:calc(74px * var(--ts))',
        `width:calc(${(58 * b.grow).toFixed(0)}px * var(--ts))`,
        `height:calc(${(58 * b.grow).toFixed(0)}px * var(--ts))`,
        'font:600 calc(11px * var(--ts))/1 system-ui,sans-serif',
        'letter-spacing:.08em', 'text-transform:uppercase',
        'color:rgba(238,244,247,.92)',
        'background:rgba(16,20,24,.34)',
        'border:calc(1.5px * var(--ts)) solid rgba(238,244,247,.30)',
        'backdrop-filter:blur(calc(3px * var(--ts)))',
        '-webkit-backdrop-filter:blur(calc(3px * var(--ts)))',
        'pointer-events:auto', 'touch-action:none',
        'padding:0', 'margin:0', 'outline:none',
        'transition:background .08s linear,transform .08s linear',
      ].join(';');
      if (b.primary) {
        el.style.borderColor = 'rgba(255,196,120,.55)';
        el.style.color = 'rgba(255,214,158,.95)';
      }
      this.root.appendChild(el);
      this.buttons.set(b.id, el);
    }
    this._layoutButtons();
  }

  /**
   * Position the button cluster from the viewport.
   *
   * Driven off CSS custom properties rather than inline pixel positions, so the
   * same layout survives an orientation change and a browser UI bar retracting
   * without a re-layout pass in JS.
   */
  _layoutButtons() {
    const ids = [...this.buttons.keys()];
    for (const id of ids) {
      const el = this.buttons.get(id);
      const spec = BUTTONS.find((b) => b.id === id);
      const grow = spec.grow;
      const s = 58 * grow;
      if (spec.side === 'top') {
        /**
         * The menu button is a RECTANGLE, not a circle, and it sits in the top
         * strip above the thumb arcs where a resting thumb cannot reach. The
         * hamburger glyph is drawn as text rather than an icon so there is no
         * asset to load, and the hit area is larger than the glyph.
         *
         * It is a rectangle specifically so it reads as a different KIND of
         * control from the round action buttons — a player should be able to
         * tell "this pauses" from "this shoots" without reading the label.
         */
        el.style.borderRadius = '10px';
        el.style.left = 'calc(12px * var(--ts))';
        el.style.top = 'calc(10px * var(--ts))';
        el.style.width = 'calc(74px * var(--ts))';
        el.style.height = 'calc(38px * var(--ts))';
        el.style.minWidth = '0';
        el.style.minHeight = '0';
        el.style.fontSize = 'calc(17px * var(--ts))';
        el.style.background = 'rgba(16,20,24,.52)';
        el.style.borderColor = 'rgba(238,244,247,.26)';
        el.style.color = 'rgba(238,244,247,.82)';
      } else if (spec.side === 'right') {
        // A vertical arc up the right edge, largest at the bottom (thumb rest).
        const order = { fire: 0, ads: 1, reload: 2, swap: 3 }[id] ?? 0;
        el.style.right = `calc(18px * var(--ts) + ${(order * (s * 0.52)).toFixed(0)}px * var(--ts))`;
        el.style.bottom = `calc(150px * var(--ts) - ${(order * (s * 0.34)).toFixed(0)}px * var(--ts))`;
      } else {
        const order = { jump: 0, crouch: 1, sprint: 2 }[id] ?? 0;
        el.style.left = `calc(16px * var(--ts) + ${(order * (s * 0.5)).toFixed(0)}px * var(--ts))`;
        el.style.bottom = `calc(190px * var(--ts) + ${(order * (s * 0.42)).toFixed(0)}px * var(--ts))`;
      }
    }
  }

  /** One `--ts` scalar drives every dimension, matching the HUD's own scale. */
  _applyScale() {
    const k = Math.max(0.62, Math.min(1.5, innerHeight / UI_SCALE_AT));
    this.root.style.setProperty('--ts', k.toFixed(3));
    // Landscape is the playable orientation. The stick and buttons are anchored
    // to the bottom corners, so in portrait they sit under the thumbs with the
    // look area squeezed to nothing. Say so rather than shipping a broken
    // layout.
    this.portrait = innerHeight > innerWidth;
    this.root.style.opacity = this.enabled ? (this.portrait ? '0.35' : '1') : '0';
    this.root.style.pointerEvents = this.enabled && !this.portrait ? 'auto' : 'none';
  }

  setEnabled(on) {
    this.enabled = !!on;
    this._applyScale();
    if (!on) this._releaseAll();
  }

  /** True when the player should be told to rotate. The UI reads this. */
  get needsRotate() {
    return this.enabled && this.portrait;
  }

  /* ------------------------------------------------------------- pointer IO */

  _onContextMenu(e) {
    // A long-press on Android otherwise raises the context menu mid-fight.
    e.preventDefault();
  }

  _onDown(e) {
    if (!this.enabled || this.portrait) return;
    const btn = e.target.closest?.('.ow-tbtn');
    if (btn) {
      e.preventDefault();
      const id = btn.dataset.id;
      btn.setPointerCapture?.(e.pointerId);
      btn.dataset.down = '1';
      btn.style.background = 'rgba(255,196,120,.26)';
      btn.style.transform = 'scale(.94)';
      /**
       * A LATCH button (the menu) is a click, not a hold: no key is synthesised
       * and nothing is released on pointerup. Everything else is a held key and
       * goes through the pending queue, which is what gives a semi-auto weapon
       * the one-frame `pressed` edge it needs to fire once per press.
       */
      if (id === 'menu') {
        this._pointers.set(e.pointerId, { role: 'latch', el: btn });
        this.onMenu?.();
        return;
      }
      const code = btn.dataset.code;
      this._pointers.set(e.pointerId, { role: 'button', code, el: btn });
      this.input.press(code);
      return;
    }
    e.preventDefault();
    // Left 40% spawns the movement stick; everything else is a look drag.
    if (e.clientX < innerWidth * 0.4 && this._pointers.size < 2) {
      this._pointers.set(e.pointerId, {
        role: 'stick',
        ox: e.clientX,
        oy: e.clientY,
        x: e.clientX,
        y: e.clientY,
        keys: new Set(),
      });
      this._stick.style.opacity = '1';
      this._stick.style.transform = `translate(${(e.clientX - 75).toFixed(1)}px, ${(e.clientY - 75).toFixed(1)}px)`;
      this._knob.style.transform = 'translate(0,0)';
    } else {
      this._pointers.set(e.pointerId, { role: 'look', x: e.clientX, y: e.clientY });
    }
  }

  _onMove(e) {
    if (!this.enabled) return;
    const p = this._pointers.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    if (p.role === 'stick') {
      p.x = e.clientX;
      p.y = e.clientY;
      this._updateStick(p);
    } else if (p.role === 'look') {
      /**
       * Fed straight into the same accumulator a mouse's `movementX/Y` uses, in
       * the same units. `Input.beginFrame` applies `config.sensitivity` and
       * zeroes it, and the capture freeze still zeroes it, so look feels
       * identical to desktop and the fire-mode state machine needs no touch case.
       *
       * Scale is 1:1 with touch movement for correctness, then multiplied by a
       * sensitivity factor for feel — a thumb sweep covers ~1/4 of the screen,
       * so raw 1:1 turns far too little for a whole screen width.
       */
      const LOOK_GAIN = 2.35;
      this.input.addLook((e.clientX - p.x) * LOOK_GAIN, (e.clientY - p.y) * LOOK_GAIN);
      p.x = e.clientX;
      p.y = e.clientY;
    }
  }

  _onUp(e) {
    const p = this._pointers.get(e.pointerId);
    if (!p) return;
    e.preventDefault?.();
    this._pointers.delete(e.pointerId);
    if (p.role === 'stick') {
      for (const code of p.keys) this.input.release(code);
      p.keys.clear();
      this._stick.style.opacity = '0';
      this._knob.style.transform = 'translate(0,0)';
    } else if (p.role === 'button') {
      this.input.release(p.code);
      p.el.dataset.down = '0';
      p.el.style.background = '';
      p.el.style.transform = '';
    } else if (p.role === 'latch') {
      // Only the visual press state clears. A latch fired once on pointerdown
      // and has no key to release.
      p.el.dataset.down = '0';
      p.el.style.background = '';
      p.el.style.transform = '';
    }
  }

  /**
   * Turn stick displacement into four synthetic key codes.
   *
   * The stick is digital, not analogue: it snaps to the eight compass
   * directions. That is deliberate. A real analogue stick feeds a magnitude into
   * the movement command, and a touch input that only ever produced 0.0 or 1.0
   * magnitude would make `moveVector`'s diagonal normalisation and the walk/sprint
   * speed thresholds behave nothing like they do on desktop. Snapping to
   * directions means the movement code path is byte-identical to WASD.
   */
  _updateStick(p) {
    const r = STICK_RADIUS;
    let dx = (p.x - p.ox) / r;
    let dy = (p.y - p.oy) / r;
    const len = Math.hypot(dx, dy);
    // Past the ring, keep pushing the knob out but clamp the direction to unit.
    const clamped = len > 1 ? 1 / len : 1;
    this._knob.style.transform = `translate(${(dx * r * 0.55).toFixed(1)}px, ${(dy * r * 0.55).toFixed(1)}px)`;
    if (len < 0.22) {
      // Inside the dead zone, release everything — this is what lets a player
      // rest a thumb without drifting.
      for (const code of p.keys) this.input.release(code);
      p.keys.clear();
      return;
    }
    dx *= clamped;
    dy *= clamped;
    const want = new Set();
    if (dy < -0.38) want.add('KeyW');
    if (dy > 0.38) want.add('KeyS');
    if (dx < -0.38) want.add('KeyA');
    if (dx > 0.38) want.add('KeyD');
    for (const code of want) if (!p.keys.has(code)) this.input.press(code);
    for (const code of [...p.keys]) if (!want.has(code)) this.input.release(code);
    p.keys = want;
  }

  /** Drop every held control — on disable, pause, blur or capture. */
  _releaseAll() {
    for (const p of this._pointers.values()) {
      if (p.role === 'stick') for (const code of p.keys) this.input.release(code);
      else if (p.role === 'button') {
        this.input.release(p.code);
        p.el.style.background = '';
        p.el.style.transform = '';
      }
    }
    this._pointers.clear();
    this._stick.style.opacity = '0';
    this._knob.style.transform = 'translate(0,0)';
  }

  /** `Input` calls this on blur, so a lifted thumb cannot leave a key stuck. */
  releaseAll() {
    this._releaseAll();
  }

  dispose() {
    this._releaseAll();
    for (const [target, type, fn] of this._bound) target.removeEventListener(type, fn);
    this._bound.length = 0;
    removeEventListener('resize', this._onResize);
    removeEventListener('orientationchange', this._onResize);
    this.root.remove();
  }
}

export { BUTTONS as TOUCH_BUTTONS, STICK_RADIUS };
