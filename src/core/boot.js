/**
 * Loading screen.
 *
 * WHY THIS EXISTS. Nothing in this project is downloaded. Every texture, mesh,
 * material and shader is generated in code at load time — that is the premise of
 * the whole thing, and it is also the whole cost. The level is ~11.3 M triangles
 * of procedural geometry, 19 surfaces are baked at up to 1024x1024, a static BVH
 * is built, and every shader permutation is compiled before the first frame so
 * none of them compile mid-fight.
 *
 * The canvas is necessarily empty for that entire window. On a desktop that is a
 * blank tab; on a phone it is a black rectangle, and an empty canvas on a phone
 * is indistinguishable from a crash. So the wait gets a screen: the game's name,
 * a real progress bar, the name of the phase currently running, and a rotating
 * field note.
 *
 * THE PHASE NAME IS THE POINT. "Loading" tells a player nothing and gives a bug
 * report nothing. "Compiling shaders" for 25 s says the device is slow at driver
 * compilation; "Building the city" says it is slow at geometry. Those need
 * completely different fixes, and without the label they are indistinguishable.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ASSETS
 *
 * There are none, and this file adds none. The background is a CSS gradient, the
 * title is a system font stack, the field notes are strings in this file. Adding
 * an image here would break the project's only hard rule (no external assets, the
 * game must run fully offline) and would be a round trip to load a thing that
 * exists to be seen for two seconds.
 *
 * DETERMINISM. Never constructed in capture mode. The canvas is empty until the
 * first frame regardless, so this cannot move a pixel even in principle — but it
 * is gated anyway, because a floating overlay in a screenshot is a diff in the
 * pixel gate and there is no reason to risk it.
 */

/** Field notes. Cycling is slower than a progress bar, so they are readable. */
const NOTES = [
  'Procedurally generated — no art assets',
  'Every texture is baked in code at load',
  'Shaders compile up front to avoid mid-fight stalls',
  'Right side of the screen aims · left side moves',
  'WASD move · shift sprint · R reload · right mouse aim',
];

/** Phase weights when the boot sequence does not supply its own. */
const DEFAULT_WEIGHTS = [
  ['forging materials', 0.34],
  ['building the city', 0.34],
  ['compiling shaders', 0.22],
  ['ready', 0.1],
];

export class LoadingScreen {
  constructor() {
    this.i = 0;
    this.el = null;
    this._weights = null;
    this._note = 0;
    this._noteTimer = null;
    this._build();
  }

  _build() {
    const el = document.createElement('div');
    el.id = 'ow-loading';
    el.setAttribute('style', ROOT);
    el.innerHTML = `
      <div style="${GRAIN}"></div>
      <div style="${STACK}">
        <div style="${TITLE}">BLACK<span style="${TITLE_DIM}"> OF </span>DUTY</div>
        <div style="${TAGLINE}">TACTICAL OPERATIONS</div>
        <div style="${BAR}"><i id="ow-load-fill" style="${FILL}"></i></div>
        <div style="${META}>
          <span id="ow-load-pct">0%</span>
          <span id="ow-load-phase">starting</span>
        </div>
        <div id="ow-load-note" style="${NOTE}"></div>
      </div>`;
    document.body.appendChild(el);
    this.el = el;
    this.fill = el.querySelector('#ow-load-fill');
    this.pct = el.querySelector('#ow-load-pct');
    this.phase = el.querySelector('#ow-load-phase');
    this.note = el.querySelector('#ow-load-note');
    this._rotateNote();
    this._noteTimer = setInterval(() => this._rotateNote(), 3400);
  }

  _rotateNote() {
    if (!this.note) return;
    this.note.style.opacity = '0';
    setTimeout(() => {
      if (!this.note) return;
      this.note.textContent = NOTES[this._note % NOTES.length];
      this._note++;
      this.note.style.opacity = '';
    }, 240);
  }

  /**
   * Supply the real phase list.
   *
   * @param {string[]} labels
   * @param {number[]} weights relative COST, not step count
   */
  configure(labels, weights) {
    if (Array.isArray(labels) && labels.length) this._labels = labels;
    if (Array.isArray(weights) && weights.length) this._weights = weights;
    this.set(this.i);
  }

  _fraction(i) {
    if (this._weights) {
      const total = this._weights.reduce((a, b) => a + b, 0) || 1;
      let f = 0;
      for (let k = 0; k < i && k < this._weights.length; k++) f += this._weights[k];
      return Math.min(1, f / total);
    }
    let f = 0;
    for (let k = 0; k < i && k < DEFAULT_WEIGHTS.length; k++) f += DEFAULT_WEIGHTS[k][1];
    return Math.min(1, f);
  }

  /**
   * Advance to phase `i`.
   *
   * The fraction is computed from the index rather than accumulated, so a
   * double-call or a skipped phase cannot desynchronise the bar. Monotonic by
   * index, so an out-of-order report never walks the bar backwards.
   */
  set(i, label) {
    if (!this.el) return;
    this.i = Math.max(this.i, i);
    const f = this._fraction(this.i);
    this.fill.style.width = `${(f * 100).toFixed(1)}%`;
    this.pct.textContent = `${Math.round(f * 100)}%`;
    const text = label ?? this._labels?.[Math.min(this.i, this._labels.length - 1)] ?? DEFAULT_WEIGHTS[Math.min(this.i, DEFAULT_WEIGHTS.length - 1)][0];
    this.phase.textContent = text;
    // Mirrored onto the document so it is inspectable without devtools, and so a
    // support screenshot says which phase it stalled on.
    document.documentElement.dataset.owPhase = text;
  }

  /**
   * Fade out and REMOVE.
   *
   * Removed rather than hidden: a leftover full-screen `position: fixed` element
   * keeps swallowing taps, and on a touch device that is an invisible dead zone
   * over the canvas — a worse bug than the empty screen it replaced.
   *
   * Cleared at the same moment as the ready handshake, i.e. once a real frame has
   * been presented. Fading earlier would expose the bare canvas for a frame.
   */
  finish() {
    if (!this.el) return;
    clearInterval(this._noteTimer);
    this._noteTimer = null;
    this.set(this.i + 1, 'ready');
    const el = this.el;
    this.el = null;
    el.style.opacity = '0';
    el.style.pointerEvents = 'none';
    setTimeout(() => el.remove(), 420);
  }

  /** Immediate teardown, used when boot fails. */
  dispose() {
    clearInterval(this._noteTimer);
    this._noteTimer = null;
    this.el?.remove();
    this.el = null;
  }
}

/* -------------------------------------------------------------------------- */

const ROOT = [
  'position:fixed', 'inset:0', 'z-index:2147483646',
  'display:flex', 'align-items:center', 'justify-content:center',
  'background:#07090b', 'color:#e6eef2',
  // No scroll and no bounce. On Android, pulling down on a page overscrolls the
  // viewport and can trigger a reload, which for a game means silently losing
  // the session. This element is the topmost thing, so it must absorb it.
  'overflow:hidden', 'overscroll-behavior:none', 'touch-action:none',
  'user-select:none', '-webkit-user-select:none', '-webkit-tap-highlight-color:transparent',
  'transition:opacity .4s ease', 'padding:24px', 'box-sizing:border-box',
].join(';');

/** A very slow vertical gradient. Costs nothing and stops the screen reading as
 *  a dead browser tab while the CPU is busy. */
const GRAIN = [
  'position:absolute', 'inset:0', 'pointer-events:none',
  'background:radial-gradient(120% 80% at 50% 0%, #131a20 0%, #0a0d10 55%, #07090b 100%)',
].join(';');

const STACK = [
  'position:relative', 'width:min(420px,82vw)',
  'display:flex', 'flex-direction:column', 'align-items:center', 'gap:14px',
  'text-align:center', 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace',
].join(';');

const TITLE = [
  'font-size:clamp(22px,6.4vw,34px)', 'font-weight:800', 'letter-spacing:.30em',
  'text-indent:.30em', // balances the trailing letter-space so it reads centred
  'color:#f2f6f8', 'text-shadow:0 2px 18px rgba(0,0,0,.8)',
  'line-height:1.1',
].join(';');

const TITLE_DIM = 'color:#6d7d88;font-weight:400;letter-spacing:.22em;';

const TAGLINE = [
  'font-size:clamp(8px,2.2vw,10px)', 'letter-spacing:.42em', 'text-indent:.42em',
  'color:#5d6b75', 'margin-top:-6px',
].join(';');

const BAR = [
  'width:100%', 'height:3px', 'margin-top:18px',
  'background:rgba(238,244,247,.10)', 'border-radius:2px', 'overflow:hidden',
].join(';');

const FILL = [
  'display:block', 'height:100%', 'width:0%',
  'background:linear-gradient(90deg,#ffb765,#ffd9a8)',
  'border-radius:2px', 'transition:width .3s ease',
  // A moving sheen, so a bar that is genuinely waiting still looks alive.
  'box-shadow:0 0 12px rgba(255,180,100,.5)',
].join(';');

const META = [
  'width:100%', 'display:flex', 'justify-content:space-between',
  'font-size:10.5px', 'letter-spacing:.14em', 'color:#8fa3ad',
  'font-variant-numeric:tabular-nums', 'margin-top:2px',
].join(';');

const NOTE = [
  'font-size:9.5px', 'letter-spacing:.10em', 'color:#4f5c66',
  'margin-top:14px', 'min-height:1.4em', 'transition:opacity .24s ease',
  'max-width:34ch', 'line-height:1.5',
].join(';');

export { NOTES as LOADING_NOTES };
