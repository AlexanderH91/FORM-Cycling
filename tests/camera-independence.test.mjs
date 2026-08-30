/* Do not depend on where the rider put the phone.
 *
 * Nine rides, same bike, saddle untouched: the knee read anywhere from 27° to
 * 39°. The saddle did not move — the camera did. Riders move a phone between
 * rides, the ground is not level, it slips, they use the front camera because
 * they can see the screen. Any measurement that is really a measurement of the
 * phone's position will keep doing this, and no amount of instruction fixes it.
 *
 * So the angle is read from the model's metric 3D pose, where the camera is
 * not a term, and the picture-plane reading is kept beside it as the record of
 * what the camera was doing. */
import { browser, BASE, T, finish } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const c = await b.newContext({ viewport: { width: 393, height: 852 } });
const page = await c.newPage();
await page.goto(`${BASE}/index.html`);

/* One leg, one position, filmed from four camera placements a rider might
   plausibly produce. Projected to the picture the angle wanders; measured in
   three dimensions it does not. */
const r = await page.evaluate(async () => {
  const { angleAt, angleAt3D, squareUp } = await import('/js/analysis.js');

  // A leg in metres, hip-centred, as the model reports world landmarks.
  const hip = { x: 0, y: 0, z: 0 };
  const knee = { x: 0.34, y: 0.28, z: 0.02 };
  const ankle = { x: 0.30, y: 0.68, z: -0.03 };
  const truth = 180 - angleAt3D(hip, knee, ankle);

  /* Project through a pinhole camera at a given yaw, height and distance —
     the three things that differ between one ride and the next. */
  const project = (p, { yaw, camY, dist }) => {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const x = p.x * cy - p.z * sy;
    const z = p.x * sy + p.z * cy + dist;
    const y = p.y - camY;
    return { x: x / z, y: y / z };
  };
  const flatAt = (cam) => {
    const P = (p) => project(p, cam);
    return 180 - angleAt(P(hip), P(knee), P(ankle));
  };

  // Four placements: square and level, then off-square, then high, then close.
  const shots = [
    { yaw: 0,             camY: 0,     dist: 2.5 },
    { yaw: 14 * Math.PI / 180, camY: 0,     dist: 2.5 },
    { yaw: 0,             camY: 0.45,  dist: 2.5 },
    { yaw: 8 * Math.PI / 180,  camY: -0.3,  dist: 1.4 },
  ];
  const flat = shots.map(flatAt);
  // The world reading is the same number every time: the camera is not in it.
  const world = shots.map(() => 180 - angleAt3D(hip, knee, ankle));

  const spread = (a) => Math.max(...a) - Math.min(...a);
  return {
    truth: +truth.toFixed(1),
    flat: flat.map((v) => +v.toFixed(1)),
    flatSpread: +spread(flat).toFixed(1),
    // Bias matters as much as spread: a flat read can be steady and wrong.
    flatBias: +Math.max(...flat.map((v) => Math.abs(v - truth))).toFixed(1),
    worldSpread: +spread(world).toFixed(1),
    // the aspect-ratio helper is still what the picture needs
    squareUpStillThere: typeof squareUp === 'function',
  };
});

/* The knee range this app judges against is only 10° wide, so a couple of
   degrees of camera is not a rounding error — it is a fifth of the answer. */
T('the same leg reads differently from four plausible phone placements',
  r.flatSpread > 2 && r.flatBias > 2,
  `${r.flat.join('°, ')}° for one leg that never moved — ${r.flatSpread}° apart, and up to ${r.flatBias}° off the truth`);
T('measured in three dimensions it reads the same every time',
  r.worldSpread < 0.01, `${r.truth}° from all four`);
T('and the picture still has its own maths', r.squareUpStillThere);

/* The pipeline has to actually use it, in both passes. Reading the re-checked
   strokes flat while the rest of the clip was read in 3D would put two
   different measurements into one median. */
const wired = await page.evaluate(async () => {
  const src = await (await fetch('/js/analysis.js')).text();
  const readFrame = src.slice(src.indexOf('function readFrame'), src.indexOf('async function loadFine'));
  return {
    sweepKeepsWorld: /res\.worldLandmarks\?\.\[0\]/.test(src),
    sweepUsesWorld: /kneeBend: kneeFromWorld\(f\.w, side\)/.test(src),
    fineKeepsWorld: /w: r\.worldLandmarks\?\.\[0\]/.test(src),
    fineUsesWorld: /kneeBend: kneeFromWorld\(w, side\)/.test(readFrame),
    keepsFlatBeside: (src.match(/kneeFlat: 180 - angleAt/g) || []).length === 2,
    guardsNonsense: /bend >= 0 && bend <= 160/.test(src),
    fallsBack: /kneeFromWorld\([^)]*\) \?\? \(180 - angleAt/.test(src),
    recordsHowRead: /howRead: \{/.test(src) && /space: bdcM\.every/.test(src),
  };
});
T('the sweep reads the knee in three dimensions', wired.sweepKeepsWorld && wired.sweepUsesWorld);
T('and so does the accurate re-read, so one median holds one measurement',
  wired.fineKeepsWorld && wired.fineUsesWorld);
T('a clip with no metric pose still reports, the old way', wired.fallsBack);
T('and a depth reading that is not a leg is refused rather than used', wired.guardsNonsense);
T('the picture-plane reading is kept beside it', wired.keepsFlatBeside,
  'both passes record what the camera was doing');
T('every ride records how it was read', wired.recordsHowRead,
  'so "camera or us?" is answerable from the rides, not from a feeling');

/* The framing guide: a line to put the saddle on, because "phone at saddle
   height" is a measurement nobody standing in a shed can judge. */
const guide = await page.evaluate(async () => {
  const src = await (await fetch('/js/pages/analyze.js')).text();
  const css = await (await fetch('/css/app.css')).text();
  return {
    inThePreview: /<div class="guide" id="guide"/.test(src),
    everyViewHasOne: (src.match(/online: "/g) || []).length === 3,
    namesTheLine: /online: "Saddle on this line"/.test(src),
    dashed: /\.gline\{[^}]*dashed/.test(css) && /\.gbox\{[^}]*dashed/.test(css),
    hiddenOverFootage: /guide\.classList\.add\("hidden"\)/.test(src),
    shownWithTheLens: /guide\.classList\.remove\("hidden"\)/.test(src),
    noMoreGuessedDistance: !/hint: "Phone at saddle height/.test(src),
  };
});
T('the preview draws a frame and a line to line up with', guide.inThePreview);
T('each angle says what to put on the line', guide.everyViewHasOne && guide.namesTheLine);
T('the guide is dashed — a reference, never the rider', guide.dashed);
T('it is there through the lens and gone over a take',
  guide.shownWithTheLens && guide.hiddenOverFootage);
T('and nobody is asked to judge a height in mid-air any more',
  guide.noMoreGuessedDistance, '"saddle on this line" is checkable; "at saddle height" is not');

await b.close();
finish();
