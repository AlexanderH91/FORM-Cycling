/* The axle was the one landmark this app placed rather than saw.
 *
 * A constant said it sits 28% of the way from the toe back towards the heel,
 * because "cleats are normally set under the ball of the foot" — a population
 * average standing in for a measurement, with the whole fore/aft number built
 * on top of it. It does not need to be assumed: through a stroke the foot
 * revolves about the bottom bracket and rocks about the spindle, so every point
 * on it traces a circle plus a wobble, except the spindle, which traces the
 * cleanest circle there is. */
import { browser, BASE, T, finish } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage();
await page.goto(`${BASE}/index.html`);

const r = await page.evaluate(async () => {
  const { pedalAxle, kneeOverAxle, fitCircle } = await import('/js/analysis.js');
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

  /* A rider pedalling. The spindle sits 0.34 of the way along the foot and
     traces a crank circle of radius 0.09; the foot rocks ±12° about it, which
     is what smears every other point on the foot off a circle. */
  const CRANK = 0.09, ALONG = 0.34, FOOT = 0.13, BBx = 0.50, BBy = 0.70;
  const rows = [];
  for (let i = 0; i < 200; i++) {
    const a = (i / 22) * 2 * Math.PI;
    const sx = BBx + CRANK * Math.cos(a), sy = BBy + CRANK * Math.sin(a);
    const tilt = (12 * Math.PI / 180) * Math.sin(a + 0.7);   // the foot rocking
    const dx = Math.cos(tilt), dy = Math.sin(tilt);
    // spindle = toe + ALONG*(heel - toe), so toe is ALONG*FOOT ahead of it
    const toe  = { x: sx - ALONG * FOOT * dx,       y: sy - ALONG * FOOT * dy };
    const heel = { x: sx + (1 - ALONG) * FOOT * dx, y: sy + (1 - ALONG) * FOOT * dy };
    rows.push({
      t: i / 15, conf: 0.9, femur: 0.20, ankleY: sy,
      x: { sho: 0.30, hip: 0.50, knee: 0.44, ankle: sx, heel: heel.x, toe: toe.x },
      fy: { heel: heel.y, toe: toe.y },
    });
  }

  const found = pedalAxle(rows);
  const off = kneeOverAxle(rows, 15);

  /* The same rider as the model actually sees them: every landmark jittered
     by about half a per cent of the frame, and one frame in twelve with the
     foot put somewhere that is not the foot — on the chainring, on the other
     pedal. The spindle must still be found, and the circle must still be
     the crank. */
  const dirty = rows.map((q) => {
    const bad = rnd() < 1 / 12;
    const j = () => 0.004 * gauss();
    const wild = () => (bad ? (rnd() - 0.5) * 0.25 : 0);
    return { ...q,
      x: { ...q.x, heel: q.x.heel + j() + wild(), toe: q.x.toe + j() + wild() },
      fy: { heel: q.fy.heel + j() + wild(), toe: q.fy.toe + j() + wild() } };
  });
  const foundDirty = pedalAxle(dirty);
  const spindlePts = dirty.map((q) => ({ x: q.x.toe + ALONG * (q.x.heel - q.x.toe), y: q.fy.toe + ALONG * (q.fy.heel - q.fy.toe) }));
  const robust = fitCircle(spindlePts), plain = fitCircle(spindlePts, { robust: false });
  return {
    along: found?.along, crank: found?.r, fit: found?.residual,
    trueAlong: ALONG, trueCrank: CRANK,
    cm: off?.fromCrank, spindle: off?.spindle,
    // a clip where the foot never went round: no circle, no measurement
    dirty: foundDirty ? { along: foundDirty.along, crank: foundDirty.r, fit: foundDirty.residual, dropped: foundDirty.dropped } : null,
    robust: robust ? { r: robust.r, fit: robust.residual, dropped: robust.dropped } : null,
    plain: plain ? { r: plain.r, fit: plain.residual } : null,
    still: pedalAxle(rows.map((q) => ({ ...q, x: { ...q.x, heel: 0.55, toe: 0.42 }, fy: { heel: 0.70, toe: 0.70 } }))),
  };
});

T('the spindle is found on the foot, not assumed at 28%',
  Math.abs(r.along - r.trueAlong) <= 0.04,
  `found it ${(r.along * 100).toFixed(0)}% along, true ${(r.trueAlong * 100).toFixed(0)}% — the constant said 28%`);
T('and the circle it traced is the crank',
  Math.abs(r.crank - r.trueCrank) / r.trueCrank < 0.05,
  `${r.crank.toFixed(4)} vs ${r.trueCrank} in frame units`);
T('the fit says how much to trust it', r.fit < 0.05, `off a true circle by ${(r.fit * 100).toFixed(1)}% of its radius`);

/* And that circle is a ruler. Cranks are 17 cm on almost every bike, so the
   offset in centimetres needs no height and no population thigh — and because
   both numbers come off the same frame, no scale and no camera angle either. */
T('centimetres come off the rider\'s own pedals, with no height needed',
  r.cm != null && Math.abs(r.cm) < 12,
  `${r.cm} cm, from a crank measured in this clip`);
T('and the report keeps what it measured, to be checked later',
  r.spindle && r.spindle.along === r.along && r.spindle.crank > 0);

T('with real jitter and one misread foot in twelve, the spindle is still found',
  r.dirty && Math.abs(r.dirty.along - r.trueAlong) <= 0.08 && Math.abs(r.dirty.crank - r.trueCrank) / r.trueCrank < 0.08,
  r.dirty ? `${(r.dirty.along * 100).toFixed(0)}% along, crank ${r.dirty.crank.toFixed(4)} vs ${r.trueCrank}, ${r.dirty.dropped} frames set aside` : 'lost the spindle');
T('the misread frames are set aside rather than averaged in',
  r.robust && r.plain && r.robust.fit < r.plain.fit && Math.abs(r.robust.r - r.trueCrank) <= Math.abs(r.plain.r - r.trueCrank),
  r.robust ? `residual ${(r.robust.fit * 100).toFixed(1)}% robust vs ${(r.plain.fit * 100).toFixed(1)}% plain; radius off by ${(100 * Math.abs(r.robust.r - r.trueCrank) / r.trueCrank).toFixed(1)}% vs ${(100 * Math.abs(r.plain.r - r.trueCrank) / r.trueCrank).toFixed(1)}%` : 'no fit');
T('a foot that never traced a circle gives no spindle at all',
  r.still === null, 'better the population figure than centimetres built on a bad fit');

await b.close();
finish();
