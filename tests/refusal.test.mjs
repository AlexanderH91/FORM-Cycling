/* What a refused read is allowed to say.
 *
 * From a real screen: a card headed "We couldn't trust this read" with, three
 * lines below it, "Analyzed on your phone across – pedal strokes · front &
 * behind add more when you film them". The footnote sat outside the branch, so
 * the app contradicted itself and then pointed the rider at the two angles
 * that were not the problem. And the refusal itself had thrown away the counts
 * that caused it, so nothing on the screen could say why. */
import { browser, BASE, T, finish } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const c = await b.newContext({ viewport: { width: 393, height: 852 } });
const page = await c.newPage();
await page.goto(`${BASE}/index.html`);

const gated = await page.evaluate(async () => {
  const { drawReport } = await import('/js/pages/analyze.js');
  drawReport(document.getElementById('view'), {
    gate: 'We could only find you in 9 of the 42 frames we looked at. Get the whole bike and rider in frame, in decent light, and film again.',
    capture: { grade: 'F', sampled: 42, found: 9, detection: 0.21, visibility: 0.55 },
  }, null);
  const text = document.getElementById('view').textContent.replace(/\s+/g, ' ');
  return {
    text,
    saysWhatItSaw: /9 of the 42 frames/.test(text),
    claimsAnalysis: /Analyzed on your phone/.test(text),
    danglingCount: /across – pedal strokes|across  pedal strokes/.test(text),
    sendsYouToOtherAngles: /front & behind add more/.test(text),
    keepsTheBuild: /build \d{4}-\d{2}-\d{2}/.test(text),
    keepsThePrivacyLine: /never left your phone/.test(text),
    offersARetake: !!document.querySelector('a[href="#/analyze"]'),
  };
});

T('a refusal says what it actually saw', gated.saysWhatItSaw,
  'so a rider can tell bad framing from a clip the phone would not decode');
T('and never claims an analysis happened anyway', !gated.claimsAnalysis && !gated.danglingCount,
  gated.claimsAnalysis ? gated.text.slice(0, 90) : 'no stroke count, no "analyzed on your phone"');
T('nor sends you off to film the angles that were not the problem', !gated.sendsYouToOtherAngles);
T('the build and the privacy line still travel with it',
  gated.keepsTheBuild && gated.keepsThePrivacyLine, 'the two things a refusal still owes you');
T('and the way out is on the screen', gated.offersARetake, 'Re-record');

/* The measurement sweep must wait for a frame to exist before reading it.
   "seeked" means the seek finished, not that the frame has been presented —
   a detect() in that gap gets the previous frame or nothing, and enough of
   those gate the clip while blaming the rider's framing. */
/* The sweep must NOT wait for a presented frame, and this is the guard against
   adding it back. It was added in v22 on the reasoning that "seeked" does not
   mean the frame exists, and reverted in v23 because the rider's own sessions
   showed it fixed nothing and broke two views: requestVideoFrameCallback fires
   when a frame is PRESENTED, and a paused 1px offscreen video presents none,
   so every sample burned its whole budget. */
const reads = await page.evaluate(async () => {
  const src = await (await fetch('/js/analysis.js')).text();
  const body = (from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));
  return {
    sideSweep: body('onProgress(8, "Reading your pedal strokes', 'const { side, flipped, by: legPickedBy }'),
    viewSweep: body('async function sampleFrames', 'rows.stat = stat;'),
    stillWaits: /await paintedFrame\(video\);/.test(body('async function still(', 'function bestStill')),
    refineWaits: /await paintedFrame\(video, 400\)/.test(body('async function detectAt', 'Re-read the strokes')),
    reasonWritten: /WHY THE SWEEP DOES NOT WAIT FOR A PAINTED FRAME/.test(src),
  };
});
T('the side sweep reads the frame it seeked to, without stalling on it',
  !/await paintedFrame\(/.test(reads.sideSweep), 'adding a wait here took the pass from 14s to 46s');
T('and so does the front and rear sweep',
  !/await paintedFrame\(/.test(reads.viewSweep), 'adding a wait here took 163 sampled frames down to 6');
T('while the stills and the accurate re-read still wait, where it is cheap',
  reads.stillWaits && reads.refineWaits, 'a few dozen frames, not two thousand');
T('and the reason is written down where the next person will be tempted',
  reads.reasonWritten, 'so this is not rediscovered by shipping it again');

await b.close();
finish();
