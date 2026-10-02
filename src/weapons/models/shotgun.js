import { Assembly, box, blob, extrude, roundRect, latheZ, rodZ, tubeZ, dome, mergeAll } from '../geometry.js';
import {
  addBarrel,
  addMuzzleDevice,
  addHandguard,
  addRail,
  addPistolGrip,
  addFrontSight,
  addRearSight,
  addQdSocket,
  addSlingLoop,
  addPin,
  buildOptic,
  triggerPart,
  selectorPart,
  cartridge,
} from '../parts.js';

/**
 * The pump-action shotgun — an 870-pattern 12-gauge.
 *
 * WHY A SHOTGUN AND NOT A FOURTH RIFLE. The three existing weapons are all
 * magazine fed, mid-length, and sighted to a distance. A shotgun is the one
 * addition that changes what the player *does* rather than adding a fourth
 * number set: it is short, it is loaded one shell at a time through the bottom
 * of the receiver, and it has no magazine at all. The reload animation, the
 * ammo model and the ballistics all have to be genuinely different, which is
 * what proves the weapon pipeline is data-driven rather than three hard-coded
 * cases.
 *
 * The pump is the interesting mechanical problem. A shotgun's defining motion is
 * a reciprocating fore-end, and a rigid handguard cannot do that — the support
 * hand has to travel 78 mm with it. So the handguard is a separate moving
 * assembly parented to the barrel, and the support hand's IK target is driven
 * off the pump's position (see `gripL` below and clips.js). That is the same
 * mechanism the bolt carrier and the charging handle already use, so it costs no
 * new machinery.
 *
 * 12 GAUGE BALLISTICS, which are not rifle ballistics at all:
 *   - 9 pellets of 9 mm-ish shot, not one bullet. `ProjectileSim` spawns one
 *     travelling projectile per pellet, and a shotgun is the reason the sim has
 *     to tolerate several projectiles from a single trigger pull at all.
 *   - 410 m/s, and it drops like a stone past 25 m — the drop is what makes a
 *     shotgun a CQB weapon rather than a bad rifle.
 *   - The pattern is a fixed disc of ~3.4 deg at the muzzle, which the def
 *     expresses as `pellets` + `patternRadius` rather than as a spread cone.
 */
export function buildShotgun() {
  // Bore axis sits LOWER than a rifle's relative to the grip, because a shotgun
  // receiver is a fat single tube and the wrist sits under it.
  const bore = 0.082;
  const rRec = 0.0215; // 12-gauge receiver is genuinely fatter than an AR's
  const rMag = 0.0242;
  const railTop = bore + 0.0262;
  const zRecRear = 0.072;
  const zRecFront = -0.128;
  const zBarrelEnd = -0.452; // 20" barrel with the magazine tube alongside
  const portZ = -0.05;
  const magZ = -0.006;
  const hgZ0 = -0.132;
  const hgZ1 = -0.372;
  const hgR = 0.0262;
  const opticY = bore + 0.063;
  const opticZ = -0.03;

  const body = new Assembly('shotgun-body');

  /* ---- receiver: a fat single tube, no separate magwell ------------------ */
  const rec = latheZ(
    [
      [0, rRec * 0.5],
      [0, rRec * 0.99],
      [0.0025, rRec],
      [zRecRear - zRecFront - 0.005, rRec],
      [zRecRear - zRecFront - 0.002, rRec * 0.96],
      [zRecRear - zRecFront, rRec * 0.55],
    ],
    24
  );
  body.add(rec, 'steel', { y: bore, z: zRecRear, ry: Math.PI });
  rec.dispose();

  // Machined top strap. This is the ejection port / loading gate flat, and it is
  // what makes the receiver read as a shotgun rather than as a fat AR.
  const deck = box(0.029, 0.0075, zRecRear - zRecFront - 0.006, 0.0008, 1);
  body.add(deck, 'steel', { y: bore + rRec - 0.0028, z: (zRecRear + zRecFront) / 2 });
  deck.dispose();
  addRail(body, 'steel', zRecFront + 0.005, zRecRear - 0.006, railTop);

  // Loading port on the bottom: a shell goes in HERE, one at a time. This is the
  // single most important silhouette cue that distinguishes a shotgun.
  const gateOuter = roundRect(0.031, 0.03, 0.005, 4);
  const gateHole = roundRect(0.0255, 0.0255, 0.004, 4);
  const gate = extrude(gateOuter, 0.008, { bevel: 0.0011, holes: [gateHole] });
  body.add(gate, 'steel', { y: bore - rMag + 0.004, z: magZ, rx: -Math.PI / 2 });
  gate.dispose();
  const gateLiner = extrude(gateHole, 0.0065, { bevel: 0.0004 });
  body.add(gateLiner, 'cavity', { y: bore - rMag + 0.0055, z: magZ, rx: -Math.PI / 2 });
  gateLiner.dispose();
  // Shell carrier lifter, parked forward under the gate.
  const lifter = box(0.026, 0.0045, 0.03, 0.0008, 1);
  body.add(lifter, 'steel_bright', { y: bore - rMag + 0.0035, z: magZ - 0.001, rx: 0.2 });
  lifter.dispose();

  // Ejection port, right side — bigger than a rifle's, because a 12-gauge case
  // is 63 mm long and 18 mm across.
  const portW = 0.052;
  const portH = 0.021;
  const cav = box(0.01, portH, portW, 0.0009, 1);
  body.add(cav, 'cavity', { x: rRec - 0.005, y: bore + 0.003, z: portZ, ry: Math.PI / 2 });
  cav.dispose();
  const lip = extrude(roundRect(portW + 0.005, portH + 0.005, 0.002, 3), 0.002, {
    bevel: 0.0005,
    holes: [roundRect(portW, portH, 0.0016, 3)],
  });
  body.add(lip, 'steel', { x: rRec - 0.0008, y: bore + 0.003, z: portZ, ry: Math.PI / 2 });
  lip.dispose();

  /* ---- lower: trigger group, grip --------------------------------------- */
  const lowerBody = box(0.0265, 0.03, 0.122, 0.0016, 2);
  body.add(lowerBody, 'polymer', { y: bore - 0.0215, z: -0.018 });
  lowerBody.dispose();

  const guardOuter = [
    [-0.027, 0],
    [0.029, 0],
    [0.031, -0.006],
    [0.027, -0.022],
    [0.016, -0.027],
    [-0.019, -0.027],
    [-0.027, -0.021],
  ];
  const guardInner = [
    [-0.022, -0.003],
    [0.0235, -0.003],
    [0.0245, -0.008],
    [0.021, -0.02],
    [0.0135, -0.0235],
    [-0.016, -0.0235],
    [-0.0215, -0.0185],
  ];
  const guard = extrude(guardOuter, 0.0165, { bevel: 0.0009, holes: [guardInner] });
  body.add(guard, 'polymer', { y: bore - 0.033, z: -0.006 });
  guard.dispose();

  addPistolGrip(body, 'polymer', 'rubber', { y: 0.032, z: 0.026, angle: 0.4, len: 0.108, w: 0.031 });
  addPin(body, 'steel', 0, bore - 0.012, zRecRear - 0.004, 0.0028, 0.03);

  /* ---- barrel + magazine tube ------------------------------------------ */
  /**
   * A shotgun barrel is a straight tube with a CHOKE at the muzzle and no gas
   * block — there is nothing to vent. `addBarrel` still wants a gas position, so
   * it is pushed to the far end where the profile step is hidden under the
   * handguard.
   */
  addBarrel(body, 'steel', 'cavity', {
    y: bore,
    zBreech: -0.112,
    zMuzzle: zBarrelEnd,
    rChamber: 0.0138, // 12-gauge chamber, 54.5 mm
    rBarrel: 0.0094, // bore 18.5 mm
    rGas: 0.0102,
    gasAt: -0.4,
    knurl: false,
    seg: 24,
  });

  // Magazine tube: slimmer, offset BELOW the bore. A 12-gauge tube is 18.6 mm
  // outer against a 25.4 mm bore, and the offset is what gives the shotgun its
  // two-tone side profile.
  const magTube = tubeZ(0.0093, 0.0072, 0.31, 16, 0.0004);
  body.add(magTube, 'steel', { y: bore - 0.0208, z: -0.006, rx: Math.PI / 2, ry: Math.PI });
  magTube.dispose();
  const magCap = latheZ(
    [
      [0, 0.0093],
      [0.004, 0.0098],
      [0.019, 0.0098],
      [0.022, 0.0088],
      [0.022, 0],
    ],
    16
  );
  body.add(magCap, 'steel_soot', { y: bore - 0.0208, z: zBarrelEnd + 0.004, rx: Math.PI / 2, ry: Math.PI });
  magCap.dispose();
  // Barrel-to-mag bridge, just ahead of the receiver.
  const bridge = box(0.006, 0.021, 0.03, 0.0008, 1);
  body.add(bridge, 'steel', { y: bore - 0.0105, z: -0.142 });
  bridge.dispose();

  const muzzle = addMuzzleDevice(body, 'steel_soot', 'cavity', 'choke', zBarrelEnd, 0.0094, bore);

  /* ---- the pump fore-end: a MOVING assembly ---------------------------- */
  /**
   * This is the part that makes a shotgun a shotgun.
   *
   * It is a separate `Assembly` in `moving`, driven along its own axis by
   * clips.js. The support hand's IK target (`gripL` below) is authored at the
   * REARWARD, fully-retracted position and is offset by the pump travel, so the
   * glove stays glued to the wood through the whole stroke. Authoring the hand
   * at the midpoint instead would make the grip visibly slide at both ends of
   * the pump.
   *
   * The fore-end is a hardwood/phenolic grip, not a polymer handguard: the
   * `addHandguard` kit is an M-LOK aluminium tube and would read as a rifle part
   * on a shotgun. So it is built directly — a ribbed oval tube with a brass
   * front bead and a sling barb on the underside.
   */
  const pump = new Assembly('shotgun-pump');
  const pumpLen = 0.148;
  const pumpZ = hgZ0 - pumpLen * 0.5 + 0.006;
  const pumpBody = latheZ(
    [
      [0, hgR * 0.52],
      [0.004, hgR * 0.9],
      [0.012, hgR],
      [pumpLen - 0.014, hgR],
      [pumpLen - 0.004, hgR * 0.93],
      [pumpLen, hgR * 0.62],
      [pumpLen, 0],
    ],
    20
  );
  pump.add(pumpBody, 'polymer', { y: bore, z: hgZ0 + 0.006, ry: Math.PI });
  pumpBody.dispose();
  // Grip ribs: the fore-end has to be grippable, and at 400 mm from the eye a
  // smooth tube is a featureless cylinder.
  for (let i = 0; i < 9; i++) {
    const t = i / 8;
    const rib = latheZ(
      [
        [0, hgR * 0.99],
        [0.0035, hgR * 1.045],
        [0.0065, hgR * 0.99],
      ],
      20
    );
    pump.add(rib, 'polymer', { y: bore, z: hgZ0 + 0.006 - (0.016 + t * (pumpLen - 0.032)), ry: Math.PI });
    rib.dispose();
  }
  // Front bead: a brass bead on a short ramp, the traditional front sight on a
  // shotgun. It sits on the BARREL (static), not the pump.
  const beadRamp = blob(0.007, 0.011, 0.03, 0.0015, 2);
  body.add(beadRamp, 'steel', { y: bore + 0.0098, z: hgZ1 + 0.016 });
  beadRamp.dispose();
  const bead = dome(0.0032, 10, 0.62);
  body.add(bead, 'brass', { y: bore + 0.0158, z: hgZ1 + 0.016 });
  bead.dispose();
  addQdSocket(body, 'steel', 'steel', -hgR - 0.0008, bore, hgZ0 + 0.024, 'x', 0.0042);

  /* ---- stock: a classic straight-grip hardwood stock -------------------- */
  /**
   * Not a collapsible carbine stock. A straight comb with a black recoil pad is
   * the shape the whole class reads from, and the wrist has to sit BEHIND the
   * receiver, which is what sets the hip pose further back than the rifle's.
   */
  const stockWrist = blob(0.031, 0.044, 0.088, 0.006, 3);
  body.add(stockWrist, 'polymer', { y: bore - 0.006, z: zRecRear + 0.05, rx: -0.075 });
  stockWrist.dispose();
  const comb = box(0.03, 0.016, 0.12, 0.004, 2);
  body.add(comb, 'polymer', { y: bore + 0.018, z: zRecRear + 0.078, rx: -0.05 });
  comb.dispose();
  const buttPlate = extrude(roundRect(0.036, 0.052, 0.006, 4), 0.008, { bevel: 0.0012 });
  body.add(buttPlate, 'polymer', { y: bore - 0.021, z: zRecRear + 0.142, rx: 0.085 });
  buttPlate.dispose();
  // Recoil pad: thick, soft, and the rear-most 8 mm of the weapon. A shotgun
  // recoil pad is a distinct part, not a rubber blob, because it is the piece
  // the shooter's shoulder is actually pressed against.
  const pad = extrude(roundRect(0.038, 0.056, 0.007, 5), 0.011, { bevel: 0.0022 });
  body.add(pad, 'rubber', { y: bore - 0.023, z: zRecRear + 0.15, rx: 0.085 });
  pad.dispose();
  addSlingLoop(body, 'steel', 0.017, bore - 0.024, zRecRear + 0.03, 0.007, { ry: Math.PI / 2 });

  /* ---- sights ----------------------------------------------------------- */
  const optic = buildOptic(body, {
    rTube: 0.0132,
    len: 0.042,
    hood: 0.006,
    y: opticY,
    z: opticZ,
    railTop,
    matBody: 'alu_fine',
    matSteel: 'steel',
  });
  // The front sight is the BEAD on the barrel ramp, so no separate tower is
  // added here — a shotgun with a front sight post AND a bead is a mistake.
  addRearSight(body, 'polymer', 'alu', 0, railTop, zRecRear - 0.03, false);

  /* ---- moving parts ----------------------------------------------------- */
  /**
   * The shell in the loading gate, waiting to be fired. A shotgun has exactly
   * one chambered round, and it is visible through the open bottom — which is
   * the read that tells the player they are empty.
   */
  const chamber = new Assembly('shotgun-chamber');
  const shell = cartridge(0.0615, 0.0092, 0.011);
  chamber.add(shell.brass, 'brass', { z: -0.004, ry: Math.PI });
  chamber.add(shell.bullet, 'copper', { z: -0.036, ry: Math.PI });
  shell.brass.dispose();
  shell.bullet.dispose();

  const trigger = new Assembly('shotgun-trigger');
  const trg = triggerPart('steel_bright');
  trigger.add(trg.geo, 'steel_bright', {});
  trg.geo.dispose();

  // Pump-action guns have no selector, but `viewmodel` expects the node, so it
  // gets an empty assembly rather than a special case in the animation stack.
  const selector = new Assembly('shotgun-selector');

  return {
    id: 'shotgun',
    label: 'M-870',
    fxClass: 'shotgun',
    body,
    moving: { magazine: chamber, charging: pump, bolt: chamber, trigger, selector },
    nodes: {
      muzzle: [0, bore, muzzle.crownZ],
      chamber: [0, bore, portZ],
      /**
       * Eject port is wider and further out than a rifle's, and it throws
       * DOWNWARD-forward rather than to the right: a 12-gauge hull is far too
       * heavy to leave the port cleanly and a shotgun's action is loaded from
       * below, so the case is thrown down and forward out of the way of the
       * loading gate. fx reads this to aim the shell particle.
       */
      eject: [rRec + 0.007, bore - 0.004, portZ],
      ejectDir: [0.35, -0.86, -0.38],
      sight: [0, opticY, optic.lensZ],
      sightAxis: [0, 0, -1],
      ironSight: [0, railTop + 0.024, 0.046],
      /**
       * Right hand on the grip, same construction as the rifle's and the SMG's.
       * The shotgun's grip is further back and the receiver is fatter, so the
       * wrist sits higher relative to the bore.
       */
      gripR: {
        pos: [0.026, 0.03, 0.072],
        finger: [-0.06, -0.42, -0.9],
        back: [0.95, -0.06, -0.24],
      },
      /**
       * LEFT HAND ON THE PUMP, authored at the FULLY RETRACTED (rearward) end of
       * the stroke. clips.js offsets this by the pump travel so the glove
       * travels with the fore-end. `r` is the fore-end's outer radius: the pump
       * is a genuine cylinder on the bore axis, so the contact solve is exact.
       */
      gripL: {
        pos: [-0.004, bore, pumpZ + 0.006],
        finger: [0.06, 0.04, -0.99],
        back: [-0.9, -0.06, -0.42],
      },
      handguard: {
        axis: [0, bore, 0],
        dir: [0, 0, 1],
        r: hgR,
        z0: hgZ0,
        z1: hgZ1,
      },
      magSeat: { pos: [0, bore - rMag + 0.008, magZ], rot: [0, 0, 0] },
      /**
       * The spent hull is thrown down and forward, not dropped — the eject
       * vector above is the same information, restated for physics.
       */
      magDrop: [0.3, -0.8, -0.3],
      /**
       * There is no charging handle to pull and no bolt to cycle: the pump IS
       * the action. `chargeRest`/`chargePull` are the pump's rest and the end of
       * its stroke, so the existing charging-handle animation drives the fore-end
       * with no new clip vocabulary.
       */
      chargeRest: { pos: [0, bore, hgZ0 + 0.006], rot: [0, 0, 0] },
      chargePull: [0, 0, 0.078],
      boltRest: { pos: [0, bore, 0.004], rot: [0, 0, 0] },
      boltTravel: [0, 0, 0],
      triggerPivot: { pos: [0, bore - 0.028, 0.001], rot: [0, 0, 0] },
      triggerPull: -0.36,
      selectorPivot: { pos: [0, bore - 0.02, 0.03], rot: [0, 0, 0] },
      opticGlass: optic,
    },
    /**
     * 12-gauge: a 63.5 mm hull and an 18.5 mm rim. fx sizes the tumbling plastic
     * hull from these, which is why a shotgun shell is visibly a different
     * object from a 5.56 case rather than a recoloured one.
     */
    shell: { caseLen: 0.0635, rimR: 0.00925 },
    magSize: { len: 0.0745, w: 0.0248, d: 0.0248 },
    /**
     * Tube capacity, in shells. NOT a magazine: a shotgun feeds one at a time
     * from the bottom, and `WeaponSystem` reads this to model the shell-by-shell
     * reload and the single chambered round.
     */
    tubeCapacity: 6,
  };
}
