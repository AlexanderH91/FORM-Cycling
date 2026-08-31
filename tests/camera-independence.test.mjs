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
    namesTheLine: /online: "Your seat on this line"/.test(src),
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

/* The frame drawn on the preview has to be the frame that reaches the file.
   The stage was a fixed 4:3 box with object-fit:cover, so a 16:9 phone camera
   had its left and right edges cropped out of the preview while still being
   recorded — a guide box on that preview describes a narrower frame than the
   one going to disk, which is worse than drawing no box at all. */
const honest = await page.evaluate(async () => {
  const src = await (await fetch('/js/pages/analyze.js')).text();
  const css = await (await fetch('/css/app.css')).text();
  return {
    /* The CARD keeps its own shape, full width — a stage sized to a 9:16
       stream became a column down half the screen. But the whole frame is
       shown inside it, letterboxed, and the GUIDE is laid over the video's
       own rectangle. So the box is always the shape the camera is actually
       recording, and the card still looks like a card. */
    stageKeepsItsOwnShape: !/stage\.style\.aspectRatio/.test(src)
      && /\.stage\{[^}]*aspect-ratio:4\/3/.test(css),
    showsTheWholeFrame: /\.shot\{[^}]*object-fit:contain/.test(css),
    guideTracksTheVideo: /const scale = Math\.min\(sw \/ vw, sh \/ vh\)/.test(src)
      && /guide\.style\.width = /.test(src),
    refitOnEveryChange: /cam\.addEventListener\("loadedmetadata", fitGuide\)/.test(src)
      && /addEventListener\("resize", fitGuide\)/.test(src),
    // an upright frame is a bad frame for a bike, and says so without blocking
    asksForLandscape: /Turn your phone sideways/.test(src)
      && /turn\.classList\.toggle\("hidden", vh <= vw\)/.test(src),
    /* addEventListener, not onloadedmetadata =. Two things need that event
       now — the lens note and the guide's sizing — and an assignment would
       have silently thrown one of them away. */
    lensNoteRuns: /await cam\.play\(\)[\s\S]{0,160}showLensNote\(\)/.test(src)
      && /cam\.addEventListener\("loadedmetadata", showLensNote\)/.test(src)
      && !/cam\.onloadedmetadata =/.test(src),
    /* It reads the track it talks about. Leaving `lens` undefined here threw
       inside startCamera's try, which disabled the shutter and put "camera
       unavailable" on the screen for every rider. */
    lensNoteReadsTheLens: /function showLensNote\(\)[\s\S]{0,400}const lens = lensOf\(\)/.test(src),
    // and it is drawn on a bike, not on a word nobody has to look up
    ghostBike: /<svg class="gbike"/.test(src) && /\.gbike\{/.test(css),
    ghostOnlyOnTheSideView: /gbike"\)\.classList\.toggle\("hidden", state\.angle !== "side"\)/.test(src),
    noBikeJargon: !/online: "[^"]*hub/i.test(src),
    plainWords: /online: "Your seat on this line"/.test(src)
      && /online: "Middle of the front wheel here"/.test(src),
    fallsBackToAnyLens: /getUserMedia\(\{ video: true, audio: false \}\)/.test(src),
    saysWhenItIsTheSelfieLens: /Front camera — it works/.test(src),
    // ...and says it, rather than refusing to use it
    neverRefusesTheSelfieLens: !/facing === "user"[^\n]*return|disabled = .*selfie/i.test(src),
    recordsTheLens: /state\.lenses\[key\] = lensOf\(\)/.test(src)
      && /report\.lenses = state\.lenses/.test(src),
    /* getSettings() also carries deviceId and groupId — persistent per-origin
       identifiers for this rider's hardware. Checked in the function that
       reads the track, not across the file, because the comment beside it
       names them in order to say they are not taken. */
    noDeviceIds: !/deviceId|groupId/.test(src.slice(src.indexOf('function lensOf'), src.indexOf('function showLensNote'))),
    stillHasTheCoverRule: /object-fit:cover/.test(css),
  };
});
T('the preview is a full-width card, not a column down half the screen',
  honest.stageKeepsItsOwnShape && honest.lensNoteRuns && honest.lensNoteReadsTheLens);
T('and it shows the whole recorded frame, not the middle of it',
  honest.showsTheWholeFrame, 'letterboxed, so nothing recorded is off-screen');
T('the guide is the shape the camera is actually recording',
  honest.guideTracksTheVideo && honest.refitOnEveryChange,
  'it was a landscape box over a 9:16 stream — a frame the camera never produces');
T('and an upright phone is told a bike is wider than it is tall',
  honest.asksForLandscape, 'said on the preview, never enforced');
T('the guide draws a bike to line up with, not a part to look up',
  honest.ghostBike && honest.ghostOnlyOnTheSideView && honest.noBikeJargon,
  'its saddle sits on the line, so matching it sets the phone height');
T('and where it does use words, they are words anyone has for a bike',
  honest.plainWords, 'seat and wheels, never hubs');
T('a phone with no rear camera still gets a preview', honest.fallsBackToAnyLens,
  'the fallback used to ask for the same rear camera twice');
T('the selfie lens is named, not refused',
  honest.saysWhenItIsTheSelfieLens && honest.neverRefusesTheSelfieLens);
T('which lens shot each angle travels with the report', honest.recordsTheLens);
T('but never the hardware id that identifies the phone', honest.noDeviceIds,
  'shape and speed only');

/* The guide is help, not a gate. */
const shutter = await page.evaluate(async () => {
  const src = await (await fetch('/js/pages/analyze.js')).text();
  const handler = src.slice(src.indexOf('shoot.onclick = () => {'), src.indexOf('recorder.onstop'));
  return {
    guards: handler.match(/if \(.*\) (return|\{ [^}]*return)/g) ?? [],
    ruleWritten: /THE GUIDE NEVER BLOCKS THE SHUTTER/.test(src),
    // nothing in the shutter path looks at the guide or the framing
    mentionsGuide: /guide|gbox|gline|framed|inFrame/.test(handler),
  };
});
T('you can record without being inside the frame', !shutter.mentionsGuide,
  `the shutter checks only: ${shutter.guards.join(' / ') || 'nothing'}`);
T('and the reason is written where someone would add a gate', shutter.ruleWritten,
  'a badly framed clip we can measure beats a perfect one nobody could record');

await b.close();
finish();
