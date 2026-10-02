/**
 * Boot progress.
 *
 * WHY THIS EXISTS. Nothing in this project is downloaded as an asset. Every
 * texture, mesh, material and shader is generated in code at boot, which is the
 * entire premise — and also the entire cost. The level is ~11.3 M triangles built
 * from procedural geometry, 19 surfaces are baked at up to 1024x1024, a static
 * BVH is built, and every shader permutation is compiled before the first frame
 * so that none of them compile mid-play.
 *
 * On a fast desktop that is a few seconds. On a phone it can be ten times that,
 * and the page sits on a black rectangle the whole time, because the canvas is
 * empty until the first frame is ready and there is nothing else on the page.
 *
 * A black screen with no feedback is indistinguishable from a crash. A progress
 * bar is honest about the cost and makes it tolerable, and the status line names
 * the phase so a slow device can be diagnosed rather than guessed at.
 *
 * DETERMINISM. Pure DOM, never rendered in capture mode. The canvas still shows
 * nothing until the first frame, so this cannot move a pixel even in principle —
 * but it is gated anyway, because a floating overlay in a screenshot would be a
 * diff in the pixel gate and there is no reason to risk it.
 *
 * Progress is reported as a FRACTION of known steps rather than as a percentage
 * of measured time, because the steps are not equal in cost and a timer would
 * both overstate early progress and stall visibly at the end. It advances on the
 * real callbacks, so the bar moves when work actually finishes.
 */

const STYLE = `
  position:fixed;inset:0;z-index:2147483646;
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:18px;background:#0a0c0e;color:#e6eef2;
  font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
  transition:opacity .35s ease;padding:24px;box-sizing:border-box;
  -webkit-user-select:none;user-select:none;
`;
const BAR = 'width:min(320px,72vw);height:3px;background:rgba(238,244,247,.14);border-radius:2px;overflow:hidden;';
const FILL = 'height:100%;width:0%;background:#ffc478;border-radius:2px;transition:width .25s ease;';
const TITLE = 'font-size:15px;letter-spacing:.34em;font-weight:700;';
const SUB = 'font-size:10.5px;letter-spacing:.16em;color:#8fa3ad;text-align:center;';
const PCT = 'font-size:11px;color:#ffc478;letter-spacing:.1em;font-variant-numeric:tabular-nums;';

/**
 * Boot phases, in order. Weights are relative COST, not step count — the
 * material forge and the world build dominate everything else, and a linear
 * bar would sit at 5% for most of the wait and then jump.
 */
const PHASES = [
  ['Forging materials', 0.34],
  ['Building the city', 0.34],
  ['Compiling shaders', 0.22],
  ['Lighting the sky', 0.06],
  ['Ready', 0.04],
];

export class BootProgress {
  constructor() {
    this.i = 0;
    this.done = 0;
    this.el = null;
    /** Per-phase cost weights, supplied by the boot sequence. See `configure`. */
    this._weights = null;
    this._build();
  }

  _build() {
    const el = document.createElement('div');
    el.id = 'ow-boot';
    el.setAttribute('style', STYLE);
    el.innerHTML =
      `<div style="${TITLE}">BLACK OF DUTY</div>` +
      `<div style="${BAR}"><i id="ow-boot-fill" style="${FILL}"></i></div>` +
      `<div style="${PCT}">0%</div>` +
      `<div style="${SUB}">starting</div>`;
    document.body.appendChild(el);
    this.el = el;
    this.fill = el.querySelector('#ow-boot-fill');
    this.pct = el.children[2];
    this.status = el.children[3];
  }

  /** Cumulative fraction once `i` phases are complete. */
  _fraction(i) {
    let f = 0;
    for (let k = 0; k < i && k < PHASES.length; k++) f += PHASES[k][1];
    return Math.min(1, f);
  }

  /**
   * Advance to phase `i` and paint its label.
   *
   * @param {number} i
   * @param {string} [label]  overrides the static phase name. Used when the
   *   caller knows more than the table does — the boot sequence passes the
   *   actual subsystem being initialised, which is a more honest label than any
   *   fixed list ("Building the city" vs "world").
   *
   * Safe to call out of order and safe to skip: the fraction is computed from
   * the index rather than accumulated, so a double-call or a skipped phase cannot
   * desynchronise the bar.
   */
  set(i, label) {
    if (!this.el) return;
    this.i = Math.max(this.i, i);
    const f = this._fraction(this.i);
    const pctText = `${Math.round(f * 100)}%`;
    this.fill.style.width = `${(f * 100).toFixed(1)}%`;
    this.pct.textContent = pctText;
    const text = label ?? PHASES[Math.min(this.i, PHASES.length - 1)][0];
    this.status.textContent = text;
    // The phase name is what makes a slow device diagnosable: a player stuck on
    // "forging materials" for 20 s knows it is texture generation, not a hang.
    document.documentElement.dataset.owBoot = text;
  }

  /**
   * Re-scale the bar to `n` phases, with per-phase cost weights.
   *
   * The static table is only a guess. The boot sequence knows exactly how many
   * subsystem inits there are and roughly what each costs, so it supplies the
   * real list and the bar stops lying about how far along it is.
   */
  configure(weights) {
    if (!Array.isArray(weights) || !weights.length) return;
    this._weights = weights;
    this.set(this.i);
  }

  _fraction(i) {
    if (this._weights) {
      const w = this._weights;
      let f = 0;
      for (let k = 0; k < i && k < w.length; k++) f += w[k];
      const total = w.reduce((a, b) => a + b, 0) || 1;
      return Math.min(1, f / total);
    }
    let f = 0;
    for (let k = 0; k < i && k < PHASES.length; k++) f += PHASES[k][1];
    return Math.min(1, f);
  }

  /**
   * Fade out and remove.
   *
   * Removed, not just hidden: a leftover full-screen element with `position:
   * fixed` swallows taps. On a touch device that would be an invisible dead zone
   * over the canvas, which is worse than the black screen it replaced.
   */
  finish() {
    if (!this.el) return;
    this.set(PHASES.length - 1);
    const el = this.el;
    this.el = null;
    el.style.opacity = '0';
    el.style.pointerEvents = 'none';
    setTimeout(() => el.remove(), 400);
  }

  /** Tear down without the fade — used when boot fails. */
  dispose() {
    this.el?.remove();
    this.el = null;
  }
}

export { PHASES as BOOT_PHASES };
