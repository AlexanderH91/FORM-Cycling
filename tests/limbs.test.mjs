/* A body is a linkage. If the hip and the ankle are visible and this rider's
   bone lengths are known, the knee is the intersection of two circles — not a
   guess, and not something a handlebar can take away. */
import { browser, BASE, T, finish } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage();
await page.goto(`${BASE}/index.html`);

const r = await page.evaluate(async () => {
  const L = await import('/js/limbs.js');
  const d = (a, c) => Math.hypot(a.x - c.x, a.y - c.y);

  // A rider with a 0.20 femur and a 0.24 tibia, pedalling.
  const F = 0.20, T = 0.24;
  const truth = [];
  for (let i = 0; i < 40; i++) {
    const a = (i / 15) * 2 * Math.PI;
    const hip = { x: 0.50, y: 0.40 };
    const knee = { x: hip.x + F * Math.sin(0.35 + 0.1 * Math.cos(a)), y: hip.y + F * Math.cos(0.35 + 0.1 * Math.cos(a)) };
    const ankle = { x: knee.x + T * Math.sin(-0.2 + 0.5 * Math.cos(a)), y: knee.y + T * Math.cos(-0.2 + 0.5 * Math.cos(a)) };
    truth.push({ hip, knee, ankle });
  }

  const bones = L.boneLengths(truth);

  // The failure that shipped: the model puts "knee" on a forearm — up near the
  // shoulder, nothing like a femur away from the hip.
  const bad = { hip: truth[10].hip, knee: { x: 0.62, y: 0.22 }, ankle: truth[10].ankle };
  const agreesWithBad = L.limbsAgree(bad.hip, bad.knee, bad.ankle, bones);
  const rebuilt = L.bestLeg(bad, bones, truth[9].knee);
  const errRebuilt = rebuilt ? d(rebuilt.knee, truth[10].knee) : null;

  // A good frame must be left alone, not "repaired".
  const good = L.bestLeg(truth[20], bones, truth[19].knee);

  // Geometry that cannot happen: ends further apart than the bones allow.
  const stretched = L.solveKnee({ x: 0, y: 0 }, { x: 0, y: F + T + 0.1 }, bones);
  const folded = L.solveKnee({ x: 0, y: 0 }, { x: 0, y: 0.001 }, bones);

  // The hint decides which of the two mirrored answers is the knee.
  const hip = { x: 0.4, y: 0.3 }, ankle = { x: 0.4, y: 0.3 + 0.30 };
  const left = L.solveKnee(hip, ankle, bones, { x: 0.30, y: 0.45 });
  const right = L.solveKnee(hip, ankle, bones, { x: 0.50, y: 0.45 });

  return {
    bones: { femur: +bones.femur.toFixed(4), tibia: +bones.tibia.toFixed(4), from: bones.from },
    trueFemur: F, trueTibia: T,
    agreesWithBad,
    errRebuilt: errRebuilt == null ? null : +errRebuilt.toFixed(4),
    badKneeError: +d(bad.knee, truth[10].knee).toFixed(4),
    goodUntouched: good && !good.repaired && d(good.knee, truth[20].knee) < 1e-9,
    stretched, folded,
    hintPicksSide: left && right && left.x < hip.x && right.x > hip.x,
    tooFar: L.movedTooFar({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.9 }, 0.08),
    notTooFar: L.movedTooFar({ x: 0.5, y: 0.5 }, { x: 0.52, y: 0.51 }, 0.08),
    fewFrames: L.boneLengths(truth.slice(0, 3)),
  };
});

T('the rider\'s own bones are measured from the frames that worked',
  Math.abs(r.bones.femur - r.trueFemur) < 0.002 && Math.abs(r.bones.tibia - r.trueTibia) < 0.002,
  `femur ${r.bones.femur} (true ${r.trueFemur}), tibia ${r.bones.tibia} (true ${r.trueTibia}), from ${r.bones.from} frames`);
T('a "knee" on a forearm does not match those bones', r.agreesWithBad === false,
  `it sat ${r.badKneeError} from the real knee`);
T('and the real knee is reconstructed from the hip and ankle instead',
  r.errRebuilt !== null && r.errRebuilt < 0.01,
  `rebuilt to within ${r.errRebuilt} — the bad guess was ${r.badKneeError} out`);
T('a frame the model got right is left exactly alone', r.goodUntouched,
  'no repair flag, no movement');
T('a leg cannot be stretched past its own bones', r.stretched === null);
T('nor folded inside them', r.folded === null);
T('the hint chooses which side the knee bends to', r.hintPicksSide);
T('a joint that teleports is caught', r.tooFar === true && r.notTooFar === false);
T('too few clean frames means no bone lengths, rather than bad ones', r.fewFrames === null);
await b.close();
finish();
