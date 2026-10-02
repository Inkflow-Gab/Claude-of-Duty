/**
 * Boot diagnostics.
 *
 * WHY THIS EXISTS. A WebGL game that fails usually fails SILENTLY. If a render
 * target's format is unsupported, three does not throw — the framebuffer comes
 * back incomplete, the draw is a no-op, and you get a black screen with an empty
 * console. On a phone there is no devtools to open, so the failure is invisible:
 * the symptom is a black rectangle and nothing else.
 *
 * That is exactly the report this was written for. It does two things:
 *
 *   1. Surfaces ANY uncaught error or rejected promise as readable text on the
 *      page, including a stack. A boot failure in `main.js` already shows a
 *      `<pre>`, but a failure inside a rAF callback or an async prewarm does not
 *      reach that handler — it dies in the frame loop and is swallowed.
 *   2. Probes the actual GL capabilities the pipeline depends on and reports
 *      which are MISSING, by name. Those names are the whole point: they turn
 *      "black screen" into "this GPU cannot render to R32F", which is a
 *      fixable statement.
 *
 * The probe is not a benchmark and it does not try to measure performance. It
 * asks one question per feature — can this context create this format — and
 * answers it by actually creating the framebuffer and asking GL whether it is
 * complete. A feature that reports itself as supported but produces an
 * incomplete framebuffer is exactly the case that produces a black screen, and
 * only a real draw catches it.
 *
 * NEVER rendered in capture mode. Anything drawn here would be a diff in the
 * pixel gate, and a diagnostic overlay that appears on failure is by definition
 * not something the baseline should contain.
 */

const STYLE = `
  position:fixed;inset:0;z-index:2147483647;
  background:#0a0c0e;color:#e6eef2;
  font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
  padding:16px;overflow:auto;box-sizing:border-box;
  -webkit-text-size-adjust:100%;
`;
const ERR_STYLE = STYLE + 'background:#140608;';
const HEAD = 'font-weight:700;color:#ff8a6a;margin:0 0 8px;font-size:13px;';
const OK = 'color:#7fe0a0;';
const BAD = 'color:#ff6b6b;';
const DIM = 'color:#8fa3ad;';

/**
 * Features the renderer actually requires, and what breaks without each.
 * `probe` is the GL enum pair to test with, or null for a plain boolean query.
 */
const REQUIREMENTS = [
  {
    name: 'EXT_color_buffer_float',
    why: 'R32F depth + velocity, R32F shadow-cascade array, RGBA32F exposure ladder. Without it most render targets are incomplete and the screen is black.',
    ext: 'EXT_color_buffer_float',
  },
  {
    name: 'EXT_color_buffer_half_float',
    why: 'RGBA16F HDR target, RG16F GTAO/contact, RGBA16F history. The entire post chain writes to these.',
    ext: 'EXT_color_buffer_half_float',
  },
  {
    name: 'OES_texture_float_linear',
    why: 'Linear filtering of float textures. Absent, half-float targets still render but are point-sampled — softer, not broken.',
    ext: 'OES_texture_float_linear',
    optional: true,
  },
  {
    name: 'EXT_float_blend',
    why: 'Blending into float targets. Absent, additive particle and bloom passes render wrong, not black.',
    ext: 'EXT_float_blend',
    optional: true,
  },
  {
    name: 'WEBGL_draw_buffers / MRT',
    why: 'The prepass writes 3 targets at once (normal + velocity + depth). WebGL2 has this by default; listed because a missing gbuffer is black-on-mobile.',
    builtin: true,
  },
];

/** Installed state, so a double-init cannot stack two overlays. */
let overlay = null;
let handlersBound = false;

/**
 * Create the WebGL2 context used for probing.
 *
 * Deliberately a THROWAWAY context, not the game's. The real renderer is created
 * later with its own options, and probing with those same options risks
 * exhausting a context that the game then cannot have (browsers cap live
 * contexts, and mobile caps them lower). This one is lost immediately.
 */
function probeContext() {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 4;
  const gl = c.getContext('webgl2', {
    antialias: false,
    depth: false,
    stencil: false,
    // No powerPreference: this context is thrown away, and asking for the
    // high-performance variant on a phone can fail for reasons irrelevant here.
  });
  return gl;
}

/** Ask GL to build a framebuffer with one colour attachment of this format. */
function framebufferComplete(gl, internalFormat, type) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, gl.RGBA, type, null);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    tex,
    0
  );
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  gl.deleteTexture(tex);
  return status === gl.FRAMEBUFFER_COMPLETE;
}

/**
 * Full capability report.
 *
 * @returns {{ ok: boolean, missing: string[], optionalMissing: string[], info: object }}
 */
export function diagnose() {
  const report = {
    ok: true,
    missing: [],
    optionalMissing: [],
    info: {},
  };

  const gl = probeContext();
  if (!gl) {
    report.ok = false;
    report.missing.push('WebGL2');
    report.info.webgl2 = 'no context — the browser refused webgl2';
    return report;
  }

  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  report.info.webgl2 = 'ok';
  report.info.renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  report.info.vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
  report.info.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  report.info.maxRenderbufferSamples = gl.getParameter(gl.MAX_SAMPLES);
  report.info.maxDrawBuffers = gl.getParameter(gl.MAX_DRAW_BUFFERS);
  report.info.maxTextureImageUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);

  for (const req of REQUIREMENTS) {
    if (req.builtin) {
      // WebGL2 guarantees MRT; a MAX_DRAW_BUFFERS below 3 is a real signal.
      const n = report.info.maxDrawBuffers;
      if (n < 3) {
        report.missing.push(req.name);
        report.info[req.name] = `MAX_DRAW_BUFFERS = ${n}, needs 3`;
      } else {
        report.info[req.name] = `ok (${n} draw buffers)`;
      }
      continue;
    }
    const has = !!gl.getExtension(req.ext);
    if (has) report.info[req.name] = 'ok';
    else {
      report.info[req.name] = 'MISSING';
      (req.optional ? report.optionalMissing : report.missing).push(req.name);
    }
  }

  // The real test. An extension can be present while the format is still not
  // renderable, and that combination is precisely what produces a black screen
  // with no error. Ask GL directly.
  if (gl.getExtension('EXT_color_buffer_float')) {
    const r32f = framebufferComplete(gl, gl.R32F, gl.FLOAT);
    const rgba32f = framebufferComplete(gl, gl.RGBA32F, gl.FLOAT);
    report.info.r32f_renderable = r32f ? 'ok' : 'INCOMPLETE';
    report.info.rgba32f_renderable = rgba32f ? 'ok' : 'INCOMPLETE';
    if (!r32f) report.missing.push('R32F render target');
    if (!rgba32f) report.missing.push('RGBA32F render target');
  }
  if (gl.getExtension('EXT_color_buffer_half_float')) {
    const rgba16f = framebufferComplete(gl, gl.RGBA16F, gl.HALF_FLOAT);
    report.info.rgba16f_renderable = rgba16f ? 'ok' : 'INCOMPLETE';
    if (!rgba16f) report.missing.push('RGBA16F render target');
  }

  // Release the throwaway context immediately; mobile browsers cap how many can
  // be live and the game is about to need one.
  gl.getExtension('WEBGL_lose_context')?.loseContext();

  report.ok = report.missing.length === 0;
  return report;
}

function show(html, isError) {
  if (overlay) {
    overlay.innerHTML += html;
    return;
  }
  overlay = document.createElement('div');
  overlay.id = 'ow-diagnostics';
  overlay.setAttribute('style', isError ? ERR_STYLE : STYLE);
  overlay.innerHTML = html;
  document.body.appendChild(overlay);
}

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

/** Human-readable report. Shown by `?debug=1` and appended to on any error. */
export function reportHtml(r, title) {
  const rows = Object.entries(r.info)
    .map(([k, v]) => {
      const bad = /MISSING|INCOMPLETE|no context/.test(String(v));
      return `<div>${esc(k)}: <span style="color:${bad ? BAD : OK}">${esc(v)}</span></div>`;
    })
    .join('');
  const why = r.missing.length
    ? `<p style="color:${BAD}">Missing: <b>${esc(r.missing.join(', '))}</b></p>`
    : `<p style="color:${OK}">All required GL features present.</p>`;
  return (
    `<h1 style="${HEAD}">${esc(title)}</h1>` +
    `<div style="margin-bottom:10px">${why}</div>` +
    `<div style="${DIM}">${rows}</div>`
  );
}

/**
 * Install global error capture. Call this FIRST, before anything that can throw.
 *
 * A rejected promise from an async `init()` inside a rAF callback never reaches
 * `main.js`'s try/catch, and an exception thrown inside `Engine.step()` kills the
 * frame loop with no visible trace. Both are the difference between "the screen
 * is black" and a message naming the file and line.
 */
export function installErrorTrap() {
  if (handlersBound) return;
  handlersBound = true;
  addEventListener(
    'error',
    (e) => {
      const where = e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno})` : '';
      show(
        `<h1 style="${HEAD}">RUNTIME ERROR</h1>` +
          `<pre style="white-space:pre-wrap;color:#ffb4a2">${esc(e.message + where)}\n\n${esc(e.error?.stack ?? '')}</pre>`,
        true
      );
    },
    true
  );
  addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    show(
      `<h1 style="${HEAD}">UNHANDLED REJECTION</h1>` +
        `<pre style="white-space:pre-wrap;color:#ffb4a2">${esc(r?.stack ?? r?.message ?? String(r))}</pre>`,
      true
    );
  });
  // A WebGL context loss is its own failure mode and produces a black screen on
  // many drivers without an error event. Listen for it, because by the time the
  // user has noticed, the context is already gone.
  addEventListener('webglcontextlost', (e) => {
    show(
      `<h1 style="${HEAD}">WEBGL CONTEXT LOST</h1>` +
        `<div style="color:#ffb4a2">The GPU dropped the WebGL context — usually an out-of-memory or a driver reset. Reload to try again.</div>`,
      true
    );
  });
}

/**
 * Full diagnosis, shown to the player.
 *
 * @param {boolean} force  show even when everything passed
 */
export function runDiagnostics(force = false) {
  let r;
  try {
    r = diagnose();
  } catch (err) {
    show(
      `<h1 style="${HEAD}">DIAGNOSTIC FAILED</h1>` +
        `<pre style="white-space:pre-wrap">${esc(err?.stack ?? String(err))}</pre>`,
      true
    );
    return null;
  }
  if (force || !r.ok) {
    show(
      reportHtml(r, r.ok ? 'DIAGNOSTICS — all required GL features present' : 'DIAGNOSTICS — INSUFFICIENT WEBGL SUPPORT'),
      !r.ok
    );
  }
  // Surface the cause to the player when the GPU genuinely cannot run this.
  if (!r.ok) {
    const detail = REQUIREMENTS.filter((q) => r.missing.includes(q.name))
      .map((q) => `<div style="margin:4px 0"><b>${esc(q.name)}</b><br><span style="${DIM}">${esc(q.why)}</span></div>`)
      .join('');
    show(
      `<h1 style="${HEAD}">CANNOT RUN ON THIS DEVICE</h1>` +
        `<div style="margin-bottom:8px">This build needs float render targets, which this GPU or browser cannot provide. ` +
        `A desktop browser with hardware acceleration enabled will run it.</div>` +
        detail,
      true
    );
    console.error('[diagnostics] unsupported GL:', r);
  } else {
    console.info('[diagnostics] GL capabilities ok:', r.info);
  }
  return r;
}
