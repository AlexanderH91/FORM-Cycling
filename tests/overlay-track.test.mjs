/* The overlay is the whole product: a number drawn on the rider at the moment
   it was taken. It was landing a fraction of a pedal stroke away from the leg,
   for two reasons this suite pins down. */
import { browser, BASE, T, finish } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage();
await page.goto(`${BASE}/index.html`);

const r = await page.evaluate(async () => {
  const A = await import('/js/analysis.js');
  const src = await (await fetch('/js/analysis.js')).text();
  const pageSrc = await (await fetch('/js/pages/analyze.js')).text();

  // A leg sweeping steadily: at 15 fps samples, what does the overlay give
  // between two samples?
  const at = (t) => ({ t, j: { hip: { x: 0.5, y: 0.3 }, knee: { x: 0.5 + t, y: 0.5 }, ankle: { x: 0.5, y: 0.7 } }, knee: 20 + t * 100 });
  const track = [at(0), at(1 / 15), at(2 / 15), at(3 / 15)];

  const mid = A.overlayAt(track, 1.5 / 15);       // exactly between two samples
  const on = A.overlayAt(track, 1 / 15);          // exactly on a sample
  const far = A.overlayAt([at(0), at(5)], 2.5);   // a gap the model lost
  const past = A.overlayAt(track, 9);             // beyond the clip

  return {
    midKneeX: mid && +mid.j.knee.x.toFixed(4),
    midAngle: mid && +mid.knee.toFixed(2),
    // halfway between sample 1 (1/15) and sample 2 (2/15)
    wantX: +(0.5 + 1.5 / 15).toFixed(4),
    wantAngle: +(20 + (1.5 / 15) * 100).toFixed(2),
    onX: on && +on.j.knee.x.toFixed(4),
    far, past,
    // the two causes
    usesRealFrameTime: /t: video\.currentTime/.test(src),
    noRequestedTime: !/t: times\[i\]/.test(src),
    drivesOffFrames: /requestVideoFrameCallback\(loop\)/.test(pageSrc),
  };
});

T('between two samples the overlay interpolates instead of snapping',
  Math.abs(r.midKneeX - r.wantX) < 1e-4, `knee x ${r.midKneeX}, want ${r.wantX}`);
T('and the angle it prints moves with it',
  Math.abs(r.midAngle - r.wantAngle) < 0.01, `${r.midAngle}° want ${r.wantAngle}°`);
T('landing exactly on a sample still gives that sample', Math.abs(r.onX - (0.5 + 1 / 15)) < 1e-4, `x=${r.onX}`);
T('a gap the model lost draws nothing rather than sliding across it', r.far === null);
T('past the end of the track, nothing', r.past === null);
T('frames are stamped with the time they are AT, not the time we asked for',
  r.usesRealFrameTime && r.noRequestedTime, 'video.currentTime, not times[i]');
T('playback redraws per presented frame, not four times a second', r.drivesOffFrames);
await b.close();
finish();
