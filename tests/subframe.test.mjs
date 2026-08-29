/* Spending time to buy accuracy. Three changes, all of which cost seeks:
   every stroke is re-read rather than a sample of twelve, both ends of the
   stroke get the accurate model rather than only the bottom, and around each
   stroke the fine model looks at three times the sweep's time resolution to
   find where the ankle actually reaches its extreme. That last one fixes a
   sampling error no better model could: at 15 fps the true bottom of a stroke
   can sit 33 ms from the frame that looked lowest. */
import { browser, BASE, T, finish } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage();
await page.goto(`${BASE}/index.html`);

const r = await page.evaluate(async () => {
  const C = await import('/js/config.js');
  const A = await import('/js/analysis.js');
  const src = await (await fetch('/js/analysis.js')).text();

  // threeOClock is now split out so those frames can be refined before use.
  const rows = [];
  for (let i = 0; i < 90; i++) {
    const a = (i / 15) * 2 * Math.PI * 1.4;
    rows.push({ conf: 0.9,
      x: { sho: 0.62, hip: 0.5, ankle: 0.5 - 0.06 * Math.cos(a), knee: 0.48, heel: 0.46, toe: 0.54 },
      femur: 0.2 });
  }
  const t = A.threeOClock(rows, 15);
  return {
    strokes: C.REFINE_STROKES, sub: C.SUBFRAME,
    readsPerStroke: C.SUBFRAME.steps * 2 + 1,
    windowMs: Math.round((C.SUBFRAME.steps / (15 * C.SUBFRAME.divisor)) * 1000),
    sweepGapMs: Math.round(1000 / 15),
    threeFound: t.three.length, forward: t.forward,
    // the shape of the pass
    subframeSearch: /wantLow \? m\.ankleY > best\.ankleY : m\.ankleY < best\.ankleY/.test(src),
    refinesTop: /refine\(tdcIdx, false/.test(src),
    refinesThree: /refine\(three, true, 94, 95, REFINE_STROKES, 0\)/.test(src),
    hipUsesRefined: /const hipTDC = tdcM\.length \? stat\(tdcM, "hip"\)/.test(src),
    threeBeforeMeasure: src.indexOf('refine(three, true') < src.indexOf('const foreaft = kneeOverAxle'),
    countsReads: /timing\.fineReads/.test(src),
  };
});

T('every stroke is re-read, not a sample of twelve', r.strokes >= 40, `budget ${r.strokes}`);
T('the sub-frame search covers most of the gap between sweep frames',
  r.windowMs >= r.sweepGapMs * 0.5, `±${r.windowMs}ms around a ${r.sweepGapMs}ms gap`);
T('it keeps the frame where the ankle is genuinely at its extreme', r.subframeSearch,
  `${r.readsPerStroke} reads per stroke`);
T('the top of the stroke gets the accurate model too', r.refinesTop);
T('and the hip fold is then measured from those frames', r.hipUsesRefined,
  'no card is left measured to a lower standard than the one above it');
T('the cranks-level frames are re-read as well', r.refinesThree);
T('and before the fore/aft figure is taken from them', r.threeBeforeMeasure);
T('threeOClock finds the forward extremes on its own', r.threeFound >= 5 && r.forward !== 0,
  `${r.threeFound} crank revolutions, facing ${r.forward < 0 ? 'left' : 'right'}`);
T('the number of frames read is reported', r.countsReads, 'so the cost is visible, not guessed');
await b.close();
finish();
