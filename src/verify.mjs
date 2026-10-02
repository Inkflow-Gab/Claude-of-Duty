/**
 * Headless verification of the mobile tier, the skin system and the shotgun.
 *
 * Run: node src/verify.mjs
 *
 * There is no test runner in this project and no CI, so this is a plain node
 * script that asserts the things which are checkable without a GPU, and exits
 * non-zero on failure. It covers the logic that a screenshot cannot: preset
 * completeness, the determinism guarantee, the density gate's arithmetic, the
 * skin remap, and the shotgun's ammo state machine.
 */
import { createConfig, detectDevice, QUALITY_PRESETS, DEFAULTS } from './core/config.js';
import { SKINS, SKIN_IDS, resolveSkin } from './weapons/skins.js';
import { WEAPON_DEFS, buildRecoilPattern } from './weapons/defs.js';
import { Settings } from './core/settings.js';
import { Rng } from './core/rng.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

let failures = 0;
let checks = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (!cond) {
    failures++;
    console.log(`  FAIL  ${label}${detail ? '  — ' + detail : ''}`);
  } else {
    console.log(`  ok    ${label}${detail ? '  (' + detail + ')' : ''}`);
  }
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/* ---------------------------------------------------------------- presets -- */
section('Quality presets');

// Every preset must define EVERY key, or `setQuality` (Object.assign) leaves the
// previous tier's value in place for the missing ones.
const KEYS = [...new Set(Object.values(QUALITY_PRESETS).flatMap((p) => Object.keys(p)))];
for (const [name, preset] of Object.entries(QUALITY_PRESETS)) {
  const missing = KEYS.filter((k) => preset[k] === undefined);
  ok(missing.length === 0, `preset "${name}" defines every key`, missing.join(',') || `${KEYS.length} keys`);
}

// The mobile tier must actually be cheaper, on every axis that costs something.
const m = QUALITY_PRESETS.mobile;
const u = QUALITY_PRESETS.ultra;
ok(m.renderScale < u.renderScale, 'mobile renderScale below ultra', `${m.renderScale} < ${u.renderScale}`);
ok(m.cascades < u.cascades, 'mobile cascades below ultra', `${m.cascades} < ${u.cascades}`);
ok(m.shadowMapSize < u.shadowMapSize, 'mobile shadow map smaller', `${m.shadowMapSize} < ${u.shadowMapSize}`);
ok(m.particleBudget < u.particleBudget, 'mobile particle budget lower', `${m.particleBudget} < ${u.particleBudget}`);
ok(m.decalBudget < u.decalBudget, 'mobile decal budget lower', `${m.decalBudget} < ${u.decalBudget}`);
ok(m.density < 1, 'mobile reduces world density', String(m.density));
ok(m.textureScale <= 0.5, 'mobile halves texture bakes', String(m.textureScale));
ok(m.pixelRatioCap <= 1, 'mobile caps DPR at 1', String(m.pixelRatioCap));
ok(m.viewSamples === 0, 'mobile drops viewmodel MSAA', String(m.viewSamples));
for (const f of ['taa', 'gtao', 'ssr', 'volumetrics', 'motionBlur']) {
  ok(m[f] === false, `mobile disables ${f}`);
}
ok(m.bloom === true, 'mobile keeps bloom (cheap, and the image needs it)');

// setQuality must fully replace, not merge, so switching from ultra to mobile
// actually lands on the mobile numbers.
{
  const cfg = createConfig({ quality: 'ultra' });
  const before = { ...cfg.q };
  cfg.setQuality('mobile');
  const changed = KEYS.filter((k) => cfg.q[k] !== before[k]);
  ok(cfg.quality === 'mobile', 'setQuality switches name');
  ok(cfg.q.renderScale === m.renderScale, 'setQuality applies renderScale exactly', String(cfg.q.renderScale));
  ok(cfg.q.density === m.density, 'setQuality applies density exactly', String(cfg.q.density));
  ok(changed.length > 0, 'setQuality changed the expected keys', `${changed.length} of ${KEYS.length}`);
}

/* -------------------------------------------------- device detection rules -- */
section('Device detection');

const realTouch = globalThis.navigator?.maxTouchPoints;
const realMM = globalThis.matchMedia;
function withDevice({ touchPoints, coarse, cores = 8, mem = 8 }, fn) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { maxTouchPoints: touchPoints, hardwareConcurrency: cores, deviceMemory: mem },
    configurable: true,
    writable: true,
  });
  globalThis.matchMedia = (q) => ({ matches: q.includes('coarse') ? coarse : false });
  try {
    return fn();
  } finally {
    if (realTouch === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, 'navigator', { value: { maxTouchPoints: realTouch }, configurable: true, writable: true });
    globalThis.matchMedia = realMM;
  }
}

ok(withDevice({ touchPoints: 5, coarse: true }, () => detectDevice().tier) === 'mobile', 'phone -> mobile');
ok(withDevice({ touchPoints: 5, coarse: true, cores: 2, mem: 2 }, () => detectDevice().tier) === 'mobile', 'weak phone -> mobile');
ok(withDevice({ touchPoints: 10, coarse: true, cores: 12, mem: 8 }, () => detectDevice().tier) === 'mobile', 'iPad-class touch -> mobile');
ok(withDevice({ touchPoints: 0, coarse: false }, () => detectDevice().tier) === 'desktop', 'desktop mouse -> desktop');
ok(withDevice({ touchPoints: 10, coarse: false, cores: 16 }, () => detectDevice().tier) === 'desktop', 'touch laptop (fine pointer) -> desktop');
ok(withDevice({ touchPoints: 0, coarse: false, cores: 2, mem: 2 }, () => detectDevice().tier) === 'desktop', 'weak desktop is NOT forced to mobile', 'by design: only a finger demotes');

/* ---------------------------------------------- the determinism guarantee -- */
section('Capture determinism');

// THE load-bearing invariant: a device sniff must never be able to change what
// the pixel gate photographs.
{
  const cfg = createConfig({ deterministic: true });
  ok(cfg.quality === 'ultra', 'deterministic run pins to ultra', cfg.quality);
  ok(cfg.q.density === 1, 'deterministic run keeps full density', String(cfg.q.density));
  ok(cfg.touch === false, 'deterministic run has no touch layer');
}
{
  // An explicit preset outranks detection.
  const cfg = withDevice({ touchPoints: 5, coarse: true }, () => createConfig({ quality: 'high' }));
  ok(cfg.quality === 'high', 'explicit preset beats a touch device', cfg.quality);
  ok(cfg.touch === true, 'touch is still recorded for the UI', String(cfg.touch));
}
{
  const cfg = withDevice({ touchPoints: 5, coarse: true }, () => createConfig());
  ok(cfg.quality === 'mobile', 'no preset on a phone -> mobile', cfg.quality);
  ok(cfg.touch === true, 'touch flag set on a phone');
}
{
  const cfg = withDevice({ touchPoints: 0, coarse: false }, () => createConfig());
  ok(cfg.quality === 'ultra', 'no preset on a desktop -> ultra', cfg.quality);
  ok(cfg.touch === false, 'no touch layer on a desktop');
  ok(cfg.q.density === 1, 'desktop density untouched', String(cfg.q.density));
}
{
  // And the device info is always present, so the menu can explain itself.
  const cfg = createConfig({ quality: 'low' });
  ok(typeof cfg.device?.tier === 'string' && !!cfg.device.reason, 'device info always recorded', cfg.device?.reason);
}

/* ------------------------------------------------------------ density gate -- */
section('World density arithmetic');

// Mirror of Assembler.d() / _gate(), which cannot be imported without a DOM.
function d(n, density) {
  if (density >= 1) return n;
  if (n <= 2) return n;
  return Math.max(1, Math.round(n * density));
}
ok(d(340, 1) === 340, 'density 1 is a no-op');
ok(d(340, 0.4) === 136, 'scales 340 to 136 at 0.4', String(d(340, 0.4)));
ok(d(2, 0.4) === 2, 'counts of 2 are never culled (no bald patches)', String(d(2, 0.4)));
ok(d(1, 0.1) === 1, 'counts of 1 are never culled', String(d(1, 0.1)));
ok(d(146, 0.4) === 58, 'rubble mounds 146 -> 58', String(d(146, 0.4)));
for (const n of [12, 24, 60, 70, 120, 180, 220, 340]) {
  ok(d(n, 0.4) >= 1 && d(n, 0.4) < n, `count ${n} reduces but survives`, String(d(n, 0.4)));
}

// The instance gate: an accumulator, so the survivors spread through the order
// rather than clumping at the front, and it is deterministic.
function gateRun(count, density) {
  let acc = 0;
  const kept = [];
  for (let i = 0; i < count; i++) {
    acc += density;
    if (acc >= 1) { acc -= 1; kept.push(i); }
  }
  return kept;
}
{
  const a = gateRun(1000, 0.4);
  const b = gateRun(1000, 0.4);
  ok(a.length === b.length && a.every((v, i) => v === b[i]), 'gate is deterministic across runs');
  ok(a.length === 400, 'gate keeps exactly 40% of 1000', String(a.length));
  // Evenly spread: no 100-long window should hold far more than its share.
  let worst = 0;
  for (let s = 0; s + 100 <= 1000; s += 50) {
    worst = Math.max(worst, a.filter((i) => i >= s && i < s + 100).length);
  }
  ok(worst <= 45, 'survivors are spread, not clumped', `worst 100-window holds ${worst}`);
  // It must not keep only the head of the list.
  ok(a[a.length - 1] > 900, 'last instances are reachable', `final survivor at ${a[a.length - 1]}`);
  ok(gateRun(1000, 1).length === 1000, 'density 1 keeps everything');
}

/* ------------------------------------------------------------------ skins -- */
section('Skins');

ok(SKIN_IDS[0] === 'issue', 'issue is first in menu order');
ok(SKIN_IDS.length >= 2, 'there is more than the stock finish', `${SKIN_IDS.length} skins`);
for (const id of SKIN_IDS) {
  const s = SKINS[id];
  ok(!!s.label, `skin "${id}" has a label`, s.label);
  ok(s.mats && typeof s.mats === 'object', `skin "${id}" has a remap table`);
  for (const [from, to] of Object.entries(s.mats)) {
    ok(!!to, `skin "${id}" maps ${from} -> ${to}`);
  }
}
{
  // Brass, copper, glass and the optic internals must not be remapped by
  // anything: a gold shell or a blue lens reads as a bug, not a skin.
  const forbidden = ['brass', 'copper', 'glass', 'optic_tube', 'lens_ring'];
  let clean = true;
  for (const s of Object.values(SKINS)) {
    for (const k of forbidden) if (s.mats[k]) clean = false;
  }
  ok(clean, 'no skin remaps brass, copper or optic glass');
}
{
  // resolveSkin must copy, never mutate the shared def.
  const before = JSON.stringify(WEAPON_DEFS.rifle);
  const a = resolveSkin(WEAPON_DEFS.rifle, 'desert');
  const b = resolveSkin(WEAPON_DEFS.rifle, null);
  ok(a !== WEAPON_DEFS.rifle, 'resolveSkin returns a new object');
  ok(JSON.stringify(WEAPON_DEFS.rifle) === before, 'WEAPON_DEFS is not mutated');
  ok(a.skinMats && a.skinMats.alu === 'alu_fde', 'desert remaps alu', a.skinMats?.alu);
  ok(b.skinMats === null, 'stock skin has no remap (null, not {})');
  ok(a.magSize === WEAPON_DEFS.rifle.magSize, 'tuning is preserved through resolveSkin');
  // Two defs must not share the remap object, or one skin change leaks.
  const c = resolveSkin(WEAPON_DEFS.rifle, 'urban');
  c.skinMats.alu = 'MUTATED';
  ok(resolveSkin(WEAPON_DEFS.rifle, 'urban').skinMats.alu === 'alu_camo', 'remap tables are per-def copies');
  // A bad id must not throw or half-apply.
  const bad = resolveSkin(WEAPON_DEFS.rifle, 'does-not-exist');
  ok(bad.skin === 'issue' && bad.skinMats === null, 'unknown skin falls back to stock');
}
{
  // Every remap target must be a real material entry.
  const { WEAPON_MATERIALS } = await import('./weapons/materials.js');
  const missing = [];
  for (const s of Object.values(SKINS)) {
    for (const [from, to] of Object.entries(s.mats)) {
      if (!WEAPON_MATERIALS[to]) missing.push(`${s.id}.${from}->${to}`);
    }
  }
  ok(missing.length === 0, 'every skin target exists in WEAPON_MATERIALS', missing.join(', ') || 'all resolve');
  // A skin that remaps nothing but still differs is a no-op the player would
  // notice; assert each non-issue skin actually changes the receiver.
  for (const s of Object.values(SKINS)) {
    if (s.id === 'issue') continue;
    ok(!!s.mats.alu, `skin "${s.id}" changes the receiver finish`);
  }
}

/* --------------------------------------------------------------- shotgun -- */
section('Shotgun');

const sg = WEAPON_DEFS.shotgun;
ok(!!sg, 'shotgun def exists');
ok(sg.magSize === 1, 'one round in the chamber', String(sg.magSize));
ok(sg.tubeCapacity >= 4, 'tube holds several shells', String(sg.tubeCapacity));
ok(sg.pellets === 9, 'nine pellets', String(sg.pellets));
ok(sg.pellets <= 9, 'pellet count is within the preallocated pool', 'pool is 9');
ok(!!sg.patternRadius, 'pattern is a disc, not a cone', String(sg.patternRadius));
ok(!!sg.pumpTime, 'has a pump time', String(sg.pumpTime));
ok(!!sg.shellLoadTime, 'shells load one at a time', String(sg.shellLoadTime));
ok(sg.damage * sg.pellets > 60, 'point-blank total is lethal', String(sg.damage * sg.pellets));
ok(sg.maxRange < sg.dropoff * 400, 'short range is the design', `${sg.maxRange} m`);
ok(sg.recoil.pitch > WEAPON_DEFS.rifle.recoil.pitch * 2, 'recoil dwarfs the rifle',
  `${sg.recoil.pitch} vs ${WEAPON_DEFS.rifle.recoil.pitch}`);
ok(sg.swayScale < 1, 'heavy weapon sways less', String(sg.swayScale));
ok(sg.rpm < 150, 'pump limits the rate of fire', String(sg.rpm));

// Recoil pattern must build and be deterministic — it seeds from the def.
{
  const p1 = buildRecoilPattern(sg, Rng);
  const p2 = buildRecoilPattern(sg, Rng);
  ok(p1.length === sg.recoil.patternLength * 2, 'pattern length matches the def', String(p1.length));
  ok(p1.every((v, i) => v === p2[i]), 'recoil pattern is deterministic');
  const maxPitch = Math.max(...Array.from({ length: sg.recoil.patternLength }, (_, i) => p1[i * 2]));
  ok(maxPitch > 0, 'pattern climbs', maxPitch.toFixed(5));
}

// The other three must be untouched by the addition.
for (const id of ['rifle', 'smg', 'pistol']) {
  const d2 = WEAPON_DEFS[id];
  ok(d2.magSize > 1, `${id} still magazine-fed`, String(d2.magSize));
  ok(d2.tubeCapacity === undefined, `${id} has no tube capacity`);
  ok(d2.pellets === undefined, `${id} fires one projectile`);
}
ok(WEAPON_DEFS.rifle.magSize === 30, 'rifle magazine unchanged', String(WEAPON_DEFS.rifle.magSize));
ok(WEAPON_DEFS.smg.magSize === 32, 'smg magazine unchanged', String(WEAPON_DEFS.smg.magSize));
ok(WEAPON_DEFS.pistol.magSize === 17, 'pistol magazine unchanged', String(WEAPON_DEFS.pistol.magSize));

/* ------------------------------------------- shotgun ammo state machine --- */
// Mirrors WeaponSystem's tube logic, which needs a DOM to instantiate.
section('Shotgun ammo state machine');

function newTubeState(def) {
  return { def, mag: def.magSize, chambered: true, reserve: def.reserve, tube: def.tubeCapacity, pumping: false };
}
function loadShell(st) {
  if (st.reserve <= 0) return;
  // Place-or-return: never debit a round that has nowhere to go.
  const intoChamber = !st.chambered;
  if (!intoChamber && st.tube >= st.def.tubeCapacity) return;
  st.reserve--;
  if (intoChamber) { st.chambered = true; st.mag = 1; }
  else st.tube++;
}
function chamberFromTube(st) {
  if (st.chambered || st.tube <= 0) return;
  st.tube--; st.chambered = true; st.mag = 1;
}
function canReload(st) {
  if (st.reserve <= 0) return false;
  if (st.def.tubeCapacity) return !(st.chambered && st.tube >= st.def.tubeCapacity);
  return st.mag < st.def.magSize;
}

{
  // Firing, then pumping, must move exactly one shell from tube to chamber.
  const st = newTubeState(sg);
  const tube0 = st.tube;
  st.chambered = false; // the shot just went out
  chamberFromTube(st);
  ok(st.chambered && st.tube === tube0 - 1, 'pump chambers one shell from the tube', `${st.tube}/${sg.tubeCapacity}`);
}
{
  // Reloading from empty must fill the chamber FIRST, then the tube. Getting
  // this backwards is the classic "freshly reloaded shotgun is empty" bug.
  const st = newTubeState(sg);
  st.chambered = false;
  st.mag = 0;
  st.tube = 0;
  st.reserve = 20;
  loadShell(st);
  ok(st.chambered && st.mag === 1, 'first shell goes into the chamber');
  ok(st.tube === 0, 'first shell does not go into the tube', String(st.tube));
  loadShell(st);
  ok(st.tube === 1, 'second shell goes into the tube', String(st.tube));
  // Over-fill deliberately: a full tube must not eat reserve.
  for (let i = 0; i < 10; i++) loadShell(st);
  ok(st.tube === sg.tubeCapacity, 'tube caps at its capacity', `${st.tube}/${sg.tubeCapacity}`);
  ok(st.reserve === 20 - (sg.tubeCapacity + 1), 'reserve debited once per shell PLACED, not per attempt', String(st.reserve));
  ok(!canReload(st), 'a full tube and a chambered gun cannot reload');
  // And the real regression: a shot emptied the chamber, so the next shell
  // must go to the chamber rather than being lost.
  st.chambered = false;
  st.mag = 0;
  const r0 = st.reserve;
  loadShell(st);
  ok(st.chambered && st.reserve === r0 - 1, 'chamber refill debits exactly one', `${r0} -> ${st.reserve}`);
}
{
  // Empty chamber but a full tube: must offer a reload, because the player
  // cannot see that the gun needs pumping from the trigger alone.
  const st = newTubeState(sg);
  st.chambered = false;
  ok(canReload(st), 'empty chamber with a full tube offers a reload');
}
{
  // A magazine-fed weapon must be entirely unaffected by the tube branch.
  const r = { def: WEAPON_DEFS.rifle, mag: 5, chambered: true, reserve: 200, tube: null };
  ok(canReload(r), 'rifle with 5/30 can reload');
  r.mag = 30;
  ok(!canReload(r), 'full rifle magazine cannot reload');
  r.reserve = 0;
  ok(!canReload(r), 'no reserve cannot reload');
}
{
  // Six shells of reserve = one full tube, and the def says so.
  ok(sg.reserve % sg.tubeCapacity === 0, 'reserve is a whole number of tubes',
    `${sg.reserve} = ${sg.reserve / sg.tubeCapacity} x ${sg.tubeCapacity}`);
}

/* ------------------------------------------------- settings persistence -- */
section('Settings persistence');

// A fake storage, so the real localStorage is never touched by the tests.
function fakeStore(seed = {}) {
  const mem = new Map(Object.entries(seed));
  return {
    mem,
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
}

function withStorage(store, fn) {
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true, writable: true });
  try {
    return fn();
  } finally {
    if (prev) Object.defineProperty(globalThis, 'localStorage', prev);
    else delete globalThis.localStorage;
  }
}

{
  // Round trip: save, then load on a fresh config through the SAME backend.
  // Both halves must be inside `withStorage` — `Settings` snapshots the backend
  // at construction, so a `Settings` built outside the wrapper would hold a
  // private in-memory shim and the two halves would not see each other.
  withStorage(fakeStore(), () => {
    const c1 = createConfig({ quality: 'low' });
    const s1 = new Settings(c1);
    s1.save({ sensitivity: 0.0044, invertY: true, skin: 'urban' });
    const c2 = createConfig({ quality: 'low' });
    const s2 = new Settings(c2);
    const got = s2.load();
    ok(Math.abs(c2.sensitivity - 0.0044) < 1e-9, 'sensitivity round trips', String(c2.sensitivity));
    ok(c2.invertY === true, 'invertY round trips');
    ok(got.skin === 'urban', 'skin round trips', got.skin);
  });
}
{
  // One key per write, and an unchanged value never touches storage.
  withStorage(fakeStore(), () => {
    const s = new Settings(createConfig());
    s.save({ invertY: true });
    ok(s.store.mem.size === 1, 'exactly one storage key written', String(s.store.mem.size));
    s.save({ invertY: true });
    ok(s.store.mem.size === 1, 'a no-op save does not add keys');
    s.save({ invertY: false, skin: 'gold' });
    ok(s.store.mem.size === 1, 'a merge save still uses one key', String(s.store.mem.size));
  });
}
{
  // Corrupt JSON must not break boot.
  const store = fakeStore({ 'black-of-duty.settings.v1': '{not json' });
  const cfg = createConfig();
  withStorage(store, () => {
    const s = new Settings(cfg);
    const r = s.load();
    ok(r !== null && typeof r === 'object', 'corrupt JSON returns empty, not throws');
    ok(store.mem.size === 0, 'corrupt JSON is discarded from storage');
    ok(Math.abs(cfg.sensitivity - 0.0022) < 1e-12, 'defaults survive corrupt storage');
  });
}
{
  // A wrong schema version is dropped rather than guessed at.
  const store = fakeStore({
    'black-of-duty.settings.v1': JSON.stringify({ v: 99, s: { invertY: true } }),
  });
  const cfg = createConfig();
  withStorage(store, () => {
    const s = new Settings(cfg);
    s.load();
    ok(cfg.invertY === false, 'future schema version is ignored, not applied');
  });
}
{
  // Out-of-range and wrong-typed values are clamped or dropped. A hand-edited
  // store must not be able to produce an unplayable config.
  const store = fakeStore({
    'black-of-duty.settings.v1': JSON.stringify({
      v: 1,
      s: { sensitivity: 999, invertY: 'yes', qualityOverride: 'not-a-preset', masterVolume: -3 },
    }),
  });
  const cfg = createConfig();
  withStorage(store, () => {
    const s = new Settings(cfg);
    let threw = false;
    try {
      s.load();
    } catch {
      threw = true;
    }
    ok(!threw, 'a bogus quality override does not throw out of load');
    ok(cfg.sensitivity <= 0.02 && cfg.sensitivity >= 0.0002, 'sensitivity clamped into range', String(cfg.sensitivity));
    ok(cfg.invertY === false, 'wrong-typed boolean dropped', String(cfg.invertY));
    ok(cfg.masterVolume >= 0, 'negative volume clamped', String(cfg.masterVolume));
  });
}
{
  // Storage that throws must degrade to no-ops, not take the game down.
  const hostile = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    },
    removeItem() {
      throw new Error('denied');
    },
  };
  const cfg = createConfig();
  withStorage(hostile, () => {
    let threw = false;
    try {
      const s = new Settings(cfg);
      s.load();
      s.save({ invertY: true });
    } catch {
      threw = true;
    }
    ok(!threw, 'a throwing storage backend never breaks the caller');
  });
  // And a backend that is absent entirely.
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  delete globalThis.localStorage;
  try {
    let threw = false;
    try {
      const s = new Settings(createConfig());
      s.load();
      s.save({ invertY: false });
    } catch {
      threw = true;
    }
    ok(!threw, 'a MISSING storage backend never breaks the caller');
  } finally {
    if (prev) Object.defineProperty(globalThis, 'localStorage', prev);
  }
}
{
  // The capture path must be immune to stored state.
  const store = fakeStore({
    'black-of-duty.settings.v1': JSON.stringify({ v: 1, s: { qualityOverride: 'low' } }),
  });
  withStorage(store, () => {
    const cfg = createConfig({ deterministic: true });
    ok(cfg.quality === 'ultra', 'deterministic config is immune to a stored override', cfg.quality);
  });
}
{
  // peek() and load() must agree.
  const store = fakeStore({ 'black-of-duty.settings.v1': JSON.stringify({ v: 1, s: { skin: 'gold' } }) });
  const cfg = createConfig();
  withStorage(store, () => {
    const s = new Settings(cfg);
    ok(s.peek().skin === 'gold', 'peek sees a stored value before load()', s.peek().skin);
    ok(s.load().skin === 'gold', 'load agrees with peek');
    s.save({ skin: 'cobalt' });
    ok(s.peek().skin === 'cobalt', 'peek reflects a write immediately');
  });
}
{
  // reset() must clear storage, or "Defaults" looks broken after a reload.
  const store = fakeStore();
  withStorage(store, () => {
    const s = new Settings(createConfig());
    s.save({ invertY: true, skin: 'gold' });
    ok(store.mem.size === 1, 'something stored');
    s.reset();
    ok(store.mem.size === 0, 'reset clears storage');
    ok(s.peek().invertY === undefined, 'reset clears the cached view');
  });
}
{
  // The quality override must actually restore a preset.
  const store = fakeStore({
    'black-of-duty.settings.v1': JSON.stringify({ v: 1, s: { qualityOverride: 'mobile' } }),
  });
  const cfg = createConfig();
  withStorage(store, () => {
    const s = new Settings(cfg);
    s.load();
    ok(cfg.quality === 'mobile', 'a stored override is applied at load', cfg.quality);
    ok(cfg.q.density === QUALITY_PRESETS.mobile.density, 'and it really changed the preset', String(cfg.q.density));
  });
}

/* --------------------------------------------------- game title plumbing -- */
section('Game name');

{
  const c = createConfig();
  ok(c.title === 'BLACK OF DUTY', 'title lives on config', c.title);
  ok(c.subtitle === 'TACTICAL OPERATIONS', 'subtitle on config');
  ok(c.title !== 'OVERWATCH', 'the old working title is not the player-facing name');
  const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
  ok(html.includes('BLACK OF DUTY'), 'document title renamed');
  ok(!html.includes('OVERWATCH'), 'old title gone from index.html');
  const { CONFIG_SRC, UI_SRC } = await import('./__probe_sources.mjs');
  ok(CONFIG_SRC.includes("GAME_TITLE = 'BLACK OF DUTY'"), 'title defined once in config');
  // In MENU_SRC, not UI_SRC: the title is rendered by ui/menu.js, and the
  // assertion has to check the file that actually contains it.
  const { MENU_SRC } = await import('./__probe_sources.mjs');
  ok(MENU_SRC.includes('cfg.title'), 'the menu reads the title from config, not a literal');
  ok(!MENU_SRC.includes('OVERWATCH'), 'old title gone from the pause menu');
}

/* ---------------------------------------------------------- kill effects -- */
section('Kill and death effects');

{
  // Attribution has to survive the whole chain: physics stamps it, ai forwards
  // it, and both ui and fx gate on it. A break anywhere means either no flare or
  // a flare on an AI kill.
  const { PHYSICS_SRC, AI_SRC, AGENT_SRC } = await import('./__probe_sources.mjs');
  ok(/by: 'player'/.test(PHYSICS_SRC), 'physics stamps by:"player" on damage:dealt');
  ok(AI_SRC.includes('e.by ?? null'), 'ai forwards the attribution to applyDamage');
  ok(AGENT_SRC.includes('this.die(point, dir, amount, by)'), 'die() forwards the killer');
  ok(/emit\('actor:death',[\s\S]*?\bby,/.test(AGENT_SRC), 'actor:death payload carries `by`');
}
{
  // The light-count rule. A kill flare that toggles `visible` would recompile
  // every lit material in the scene — measured at +33-36 programs and 640-900 ms
  // on that one frame. It must go through the pooled flash path instead.
  const { FX_SRC } = await import('./__probe_sources.mjs');
  const i0 = FX_SRC.indexOf('  onKill(e) {');
  const i1 = FX_SRC.indexOf('  onActorDeath(e) {');
  ok(i0 > 0 && i1 > i0, 'onKill and onActorDeath are both present and ordered');
  const onKill = FX_SRC.slice(i0, i1);
  ok(onKill.includes('this.lights.flash('), 'the kill flare uses the pooled flash light');
  ok(!/\.visible\s*=\s*(true|false)/.test(onKill), 'it never toggles light.visible (would recompile everything)');
  ok(!/performance\.now|Date\.now/.test(onKill), 'it is deterministic (no wall clock)');
  ok(onKill.includes('particleBudget'), 'it scales off the particle budget, not a private flag');
}
{
  // The same rules apply to the animated skin effect.
  const { SKINFX_SRC } = await import('./__probe_sources.mjs');
  ok(SKINFX_SRC.includes('owNoPrepass'), 'the skin band is kept out of the MRT prepass');
  ok(SKINFX_SRC.includes('owNoShadow'), 'the skin band is kept out of the shadow cascades');
  /**
   * Strip comments before the wall-clock check. The file's own header explains
   * WHY the wall clock is banned and names `performance.now()` while doing so, so
   * a raw grep matches the documentation. This is the documented limitation of a
   * source-level guard: it can see code, and it cannot see prose about code.
   */
  const skinfxCode = SKINFX_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/performance\.now|Date\.now/.test(skinfxCode), 'the skin effect is deterministic (no wall clock in code)');
  ok(skinfxCode.includes('elapsed'), 'the skin effect is driven by the engine clock');
}
{
  // Touch: the menu must be reachable, and no second control path may exist.
  const { TOUCH_SRC, UI_SRC } = await import('./__probe_sources.mjs');
  ok(TOUCH_SRC.includes("id: 'menu'"), 'touch has a menu button');
  ok(TOUCH_SRC.includes('latch: true'), 'the menu button is a latch, not a held key');
  ok(TOUCH_SRC.includes('this.input.press('), 'held buttons still synthesise key codes');
  ok(TOUCH_SRC.includes('addLook('), 'the look drag feeds the shared accumulator');
  ok(!/input\.isTouch/.test(UI_SRC), 'ui does not branch on a touch-specific input path');
  // The menu must not request pointer lock on touch: there is no cursor to lock
  // and on some browsers the call throws an unhandled SecurityError.
  const { MENU_SRC } = await import('./__probe_sources.mjs');
  ok(/if \(!this\.touch\) this\.ctx\.input\?\.requestPointerLock/.test(MENU_SRC), 'pointer lock is gated on !touch');
  ok(MENU_SRC.includes('releaseAll'), 'pausing releases held touch controls');
  ok(MENU_SRC.includes('ow-menu-touch'), 'the menu has a touch presentation');
}
{
  // Every skin with an effect must be a real entry, and every remap target must
  // resolve to a material.
  const { SKINS_SRC } = await import('./__probe_sources.mjs');
  const { WEAPON_MATERIALS } = await import('./weapons/materials.js');
  let effectSkins = 0;
  for (const [id, s] of Object.entries(SKINS)) {
    for (const [from, to] of Object.entries(s.mats)) {
      ok(!!WEAPON_MATERIALS[to], `skin "${id}" target ${to} exists`);
    }
    if (s.effect) {
      effectSkins++;
      ok(s.effect.kind === 'iridescence', `skin "${id}" effect kind is supported`, s.effect.kind);
      ok(s.effect.max > s.effect.min, `skin "${id}" effect sweeps a real range`, `${s.effect.min}-${s.effect.max}nm`);
      ok(s.effect.period > 0, `skin "${id}" effect has a positive period`, String(s.effect.period));
      ok((s.effect.amplitude ?? 1) <= 1, `skin "${id}" amplitude is in range`);
    }
  }
  ok(effectSkins >= 2, 'at least two skins carry a live effect', String(effectSkins));
  ok(!!WEAPON_MATERIALS.alu_reactive && !!WEAPON_MATERIALS.alu_gold, 'live-effect materials exist');
  ok(SKINS_SRC.includes('EFFECT'), 'the skin effect contract is documented in skins.js');
}

/* -------------------------------------------------- init-order robustness -- */
section('Subsystem init order');

{
  /**
   * The bug that made the deployed site black.
   *
   * `weapons.init()` pushed onto `this._off` a few lines BEFORE assigning
   * `this._off = []`, so every boot died with "Cannot read properties of
   * undefined (reading 'push')" and the page showed nothing. It passed a syntax
   * check, it passed a bundle, and it passed every other assertion in this file.
   *
   * Nothing catches an ordering mistake like that statically, but the specific
   * shape is greppable: an array that is pushed to and never assigned anywhere
   * in the same file. That is a real defect, and this is the guard for it.
   *
   * The check is deliberately narrow — it only fires on a name that is pushed
   * to and has NO assignment of the form `this.X =` anywhere in the file. A
   * class field (`X = []`) satisfies it too, so a correctly-written field is not
   * flagged; anything it DOES flag has genuinely lost its initialiser.
   */
  const { readdirSync: rd, statSync: st } = await import('node:fs');
  const files = [];
  (function walk(d) {
    for (const e of rd(d)) {
      const p = join(d, e);
      if (st(p).isDirectory()) walk(p);
      else if (p.endsWith('.js')) files.push(p);
    }
  })(join(here, ''));

  const offenders = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    // Strip comments so a `.push(` inside a doc block cannot be miscounted.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const pushed = new Set();
    for (const m of code.matchAll(/this\.([A-Za-z_$][\w$]*)\.push\(/g)) pushed.add(m[1]);
    for (const name of pushed) {
      // Any assignment form counts: constructor, init, class field, or a lazy
      // `??=`. `??=` is a genuine initialiser, not a different bug — it just does
      // not match a `=`, and narrowing the pattern to `=` flagged it wrongly.
      const assigned = new RegExp(`this\\.${name}\\s*(=[^=]|\\?\\?=)`).test(code);
      if (!assigned) offenders.push(`${f.replace(here, '')}: this.${name}`);
    }
  }
  ok(offenders.length === 0, 'no array is pushed to without an initialiser', offenders.join(', '));

  // And the specific regression, named so a future edit cannot quietly undo it.
  const { WEAPONS_SRC, AI_SRC } = await import('./__probe_sources.mjs');
  const assignAt = WEAPONS_SRC.indexOf('this._off = []');
  const pushAt = WEAPONS_SRC.indexOf('this._off.push(');
  ok(assignAt > 0 && pushAt > assignAt, 'weapons._off is initialised before it is pushed to',
    `assign@${assignAt} push@${pushAt}`);
  // dispose() must survive a partially-constructed system.
  ok(/for \(const off of this\._off \?\? \[\]\)/.test(WEAPONS_SRC),
    'weapons.dispose tolerates a missing _off');

  // Every subsystem that pushes to an event-unsubscribe list must initialise it,
  // and the two that were at risk are checked explicitly.
  for (const [name, src, field] of [
    ['weapons', WEAPONS_SRC, '_off'],
    ['ai', AI_SRC, '_off'],
  ]) {
    const a = src.indexOf(`this.${field} = []`);
    const p = src.indexOf(`this.${field}.push(`);
    ok(a > 0 && p > a, `${name}.${field} initialised before first push`,
      `assign@${a} push@${p}`);
  }
}

/* ------------------------------------------------- boot cost regressions -- */
section('Boot cost');

{
  /**
   * The skin pre-warm regression.
   *
   * `Viewmodel.prewarmMaterials` used to loop over EVERY skin. A skin is a
   * material remap, and a remapped material is a different key — which means a
   * different set of BAKED procedural textures, not merely a different program.
   * So the loop was generating and uploading 1024x1024 albedo/ORM/normal triples
   * for every variant of every part on every weapon, at boot, for skins the
   * player may never select. That was the largest avoidable cost in the boot
   * path and it is invisible to every other check here.
   *
   * The guard is the obvious one: the boot hook must not iterate the skin table.
   * The other skins are warmed by `prewarmAllSkins`, which the MENU calls.
   */
  const { WEAPONS_SRC, VIEWMODEL_SRC, MENU_SRC } = await import('./__probe_sources.mjs');
  // The loop and the yields live in the viewmodel; weapons/index.js only
  // delegates. Asserting against the wrong file is how a guard silently stops
  // guarding anything.
  const prewarmBody = VIEWMODEL_SRC.slice(
    VIEWMODEL_SRC.indexOf('prewarmMaterials(ctx'),
    VIEWMODEL_SRC.indexOf('prewarmAllSkins(')
  );
  ok(prewarmBody.length > 0, 'the viewmodel prewarm hook was found');
  ok(!/for\s*\(\s*const\s+\w+\s+of\s+Object\.values\(SKINS\)/.test(prewarmBody),
    'the BOOT prewarm does not loop over every skin');
  ok(/prewarmMaterials\(ctx = this\.ctx, \{ skinId = null \}/.test(prewarmBody),
    'one skin per call, chosen by id');
  // The escape hatch that makes the deferral sound must actually exist, and the
  // subsystem must expose it so `ui` has a single call site.
  ok(/prewarmAllSkins\(/.test(VIEWMODEL_SRC), 'prewarmAllSkins exists for the deferred path');
  ok(/prewarmAllSkins\(\)/.test(WEAPONS_SRC), 'WeaponSystem exposes prewarmAllSkins to the menu');
  const allSkins = VIEWMODEL_SRC.slice(VIEWMODEL_SRC.indexOf('async prewarmAllSkins('));
  ok(/await new Promise/.test(allSkins), 'prewarmAllSkins yields between skins so the tab can paint');
  ok(/Object\.values\(SKINS\)/.test(allSkins), 'and it is that deferred path which walks the table');
  // And the menu must be what calls it, or the deferral buys nothing.
  ok(MENU_SRC.includes('prewarmAllSkins'), 'the settings menu warms the remaining skins on open');
  ok(/if \(this\.open\) return;/.test(MENU_SRC), 'menu.show() is idempotent, so the warm fires once');
  ok(MENU_SRC.includes('this._skinsWarmed'), 'the warm is latched, not repeated every open');
}

{
  // The progress overlay must never exist in a capture, or it is a diff in the
  // pixel gate. It also must be REMOVED, not just hidden: a full-screen
  // position:fixed leftover swallows taps, which on a touch device is an
  // invisible dead zone over the canvas.
  const { MAIN_SRC } = await import('./__probe_sources.mjs');
  ok(/const boot = capture \? null : new BootProgress\(\)/.test(MAIN_SRC),
    'the boot overlay is nulled in capture mode');
  ok(MAIN_SRC.includes('boot?.dispose()'), 'a failed boot tears the overlay down');
  const bootSrc = readFileSync(join(here, 'core', 'boot.js'), 'utf8');
  ok(bootSrc.includes('el.remove()'), 'the overlay is removed from the DOM, not just hidden');
  ok(bootSrc.includes("pointerEvents = 'none'"), 'and is made click-through while fading');
  // It must be dismissed on the frame handshake, not right after engine.start(),
  // or it exposes a black canvas for one frame.
  ok(/BOOT_FRAMES[\s\S]{0,400}boot\?\.finish\(\)/.test(MAIN_SRC),
    'the overlay is dismissed only after a frame has landed');
}

{
  // Subsystem init is wrapped for progress, so each step must yield a frame or
  // the bar cannot paint and jumps 0 -> 100 in one step.
  const { MAIN_SRC } = await import('./__probe_sources.mjs');
  const wrap = MAIN_SRC.slice(MAIN_SRC.indexOf('sys.init = async'), MAIN_SRC.indexOf('try {\n  await engine.init()'));
  ok(wrap.includes('requestAnimationFrame'), 'each subsystem init yields a frame so progress paints');
  ok(wrap.includes('boot.set('), 'and reports its own step');
}

/* ------------------------------------------------------------------ done -- */
console.log(`\n${failures === 0 ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${checks - failures}/${checks} checks`);
process.exitCode = failures === 0 ? 0 : 1;
