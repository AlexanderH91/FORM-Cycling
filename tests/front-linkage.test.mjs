/* The front view's second pass, driven without a video.
 *
 * The failure this exists to stop: bars and forearms cross the legs, the model
 * puts a "knee" on a forearm, and the clip reports a knee travelling 22° when
 * a knee travels 2–10°. Bone lengths taken from the frames that worked turn
 * every hidden knee from a guess into the intersection of two circles. */
import { browser, BASE, T, finish } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage();
await page.goto(`${BASE}/index.html`);

const r = await page.evaluate(async () => {
  const { settleFrontLegs, squareUp } = await import('/js/analysis.js');
  const AR = 1080 / 1920;                 // a portrait phone clip
  const MID = AR / 2;                     // ...so mid-frame is 0.28, not 0.5
  const F = 0.10, TB = 0.12;              // femur and tibia, squared units

  const leg = (hipX, thigh, shin) => {
    const hip = { x: hipX, y: 0.40 };
    const knee = { x: hip.x + F * Math.sin(thigh), y: hip.y + F * Math.cos(thigh) };
    const ankle = { x: knee.x + TB * Math.sin(shin), y: knee.y + TB * Math.cos(shin) };
    return { hip, knee, ankle, ends: true, clean: true };
  };

  /* Forty frames of pedalling. The rider faces us, so their left leg is on the
     right of the screen. */
  const rows = [];
  for (let i = 0; i < 40; i++) {
    const a = (i / 13) * 2 * Math.PI;
    rows.push({
      t: i / 12, ar: AR, vis: 0.9,
      legs: {
        l: leg(MID + 0.06, 0.12 * Math.cos(a), 0.14 * Math.cos(a)),
        r: leg(MID - 0.06, -0.12 * Math.cos(a + 1), -0.10 * Math.cos(a + 1)),
      },
    });
  }
  const truth = rows.map((x) => ({ l: { ...x.legs.l.knee }, r: { ...x.legs.r.knee } }));

  // Frames 10-19: the bars hide the left knee and the model lands on a forearm.
  for (let i = 10; i < 20; i++) {
    rows[i].legs.l.knee = { x: 0.46, y: 0.15 };   // above the hip: not a knee
    rows[i].legs.l.clean = false;                 // ...and the ends are still good
  }

  settleFrontLegs(rows, 12);
  const tally = rows.repair;
  const bones = rows.bones;

  // How far each rebuilt knee ended up from where the leg actually was.
  let worst = 0;
  for (let i = 10; i < 20; i++) {
    const k = rows[i].j && rows[i].j.lknee;
    if (!k) { worst = 99; break; }
    // j is back in raw image coordinates; square it up again to compare.
    const sqd = { x: k.x * AR, y: k.y };
    worst = Math.max(worst, Math.hypot(sqd.x - truth[i].l.x, sqd.y - truth[i].l.y));
  }

  // The leans across the clip, which is what the card actually reports.
  const spread = (key) => {
    const v = rows.map((x) => x[key]).filter((x) => typeof x === 'number');
    return v.length ? Math.max(...v) - Math.min(...v) : null;
  };

  /* A lone leg, on the right of a portrait frame. Squared x is 0.40, which is
     right of this clip's centre line at 0.28 — but left of the flat 0.5 the
     old code compared against, so it used to be credited to the wrong leg. */
  const lone = [];
  for (let i = 0; i < 10; i++) {
    lone.push({
      t: i / 12, ar: AR, vis: 0.9,
      legs: {
        l: leg(0.40, 0.1, 0.12),
        r: { hip: { x: 0, y: 0 }, knee: { x: 0, y: 0 }, ankle: { x: 0, y: 0 }, ends: false, clean: false },
      },
    });
  }
  settleFrontLegs(lone, 12);

  return {
    tally, bones, worst,
    hasThigh: !!(rows[12].j && rows[12].j.lhip),
    rebuiltFlag: rows[12].rebuilt === true,
    cleanUntouched: rows[3].rebuilt === undefined,
    leftSpread: spread('left'), rightSpread: spread('right'),
    loneLeft: typeof lone[4].left === 'number',
    loneRight: typeof lone[4].right === 'number',
  };
});

T('the rider is measured from the frames that worked',
  r.bones && Math.abs(r.bones.femur - 0.10) < 0.002 && Math.abs(r.bones.tibia - 0.12) < 0.002,
  `femur ${r.bones && r.bones.femur.toFixed(4)}, tibia ${r.bones && r.bones.tibia.toFixed(4)}, from ${r.tally.from} legs`);

T('the ten hidden knees are rebuilt, not dropped',
  r.tally.rebuilt === 10 && r.tally.dropped === 0,
  `${r.tally.rebuilt} rebuilt, ${r.tally.measured} measured, ${r.tally.dropped} dropped`);

T('a rebuilt knee lands on the leg',
  r.worst < 0.004, `worst was ${r.worst.toFixed(4)} of frame width off the true knee`);

T('the frames the model got right are left alone',
  r.cleanUntouched && r.rebuiltFlag, 'only the repaired frames carry the flag');

T('knee travel stays in the range a knee has',
  r.leftSpread > 0.5 && r.leftSpread < 30 && r.rightSpread > 0.5 && r.rightSpread < 30,
  `left ${r.leftSpread.toFixed(1)}°, right ${r.rightSpread.toFixed(1)}° across the clip`);

T('the hip travels with the leg so the player can draw the thigh',
  r.hasThigh, 'lhip is in the track');

T('a lone leg on a portrait clip is credited to the right side of the body',
  r.loneLeft && !r.loneRight,
  'mid-frame is half the squared width, not a flat 0.5');

await b.close();
finish();
