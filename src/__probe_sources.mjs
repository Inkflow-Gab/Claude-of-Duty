/**
 * Reads a few source files as TEXT so `verify.mjs` can assert on patterns that
 * are architectural rather than behavioural.
 *
 * WHY THIS EXISTS. Several of the rules that matter most in this project are not
 * expressible as a unit test:
 *
 *   - "the kill flare must go through the pooled flash light, because toggling
 *     `light.visible` recompiles every lit material in the scene";
 *   - "the animated skin effect must read `ctx.time`, because a wall clock there
 *     breaks the pixel gate for every shot";
 *   - "the touch layer must not create a second control path".
 *
 * Each of those is a statement about source code, and the only way to check it
 * without a GPU is to read the source. A behavioural test would need a full
 * render pipeline and would still not catch a regression that preserved the
 * behaviour while changing the mechanism.
 *
 * These are guards, not a substitute for reading the code. They exist so that a
 * well-meaning edit which swaps a pooled light for a raw one, or drops the `by`
 * field, fails loudly instead of shipping as a 640 ms hitch or a missing flare.
 *
 * A grep-based test is a blunt instrument and these assertions are deliberately
 * few and specific. If one starts failing for an unrelated reason, fix the code
 * or delete the assertion — do not loosen the pattern until it passes.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), 'utf8');

export const PHYSICS_SRC = read('physics/index.js');
export const AI_SRC = read('ai/index.js');
export const AGENT_SRC = read('ai/agent.js');
export const FX_SRC = read('fx/index.js');
export const UI_SRC = read('ui/index.js');
export const MENU_SRC = read('ui/menu.js');
export const TOUCH_SRC = read('core/touch.js');
export const SETTINGS_SRC = read('core/settings.js');
export const SKINS_SRC = read('weapons/skins.js');
export const SKINFX_SRC = read('weapons/skinfx.js');
export const WEAPONS_SRC = read('weapons/index.js');
/**
 * The viewmodel is where the skin machinery actually lives. `weapons/index.js`
 * is a thin delegator for both prewarm entry points, so assertions about the
 * loop and the yields must be made against THIS file, not that one.
 */
export const VIEWMODEL_SRC = read('weapons/viewmodel.js');
export const CONFIG_SRC = read('core/config.js');
export const MAIN_SRC = read('main.js');
