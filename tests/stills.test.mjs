/* The report kept showing a measurement overlay floating on a black rectangle:
   an angle drawn on a frame that never decoded. Chromium decodes eagerly, so
   the iOS failure itself cannot be reproduced here — what these tests pin down
   is the machinery that fixes it and, more importantly, the rule that a still
   with no picture in it is never shipped with a drawing on top. */
import { browser, BASE, T, finish } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage();
await page.goto(`${BASE}/index.html`);

const r = await page.evaluate(async () => {
  const A = await import('/js/analysis.js');

  const canvasOf = (paint) => {
    const c = document.createElement('canvas');
    c.width = 240; c.height = 135;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    paint(ctx, c.width, c.height);
    return { c, ctx };
  };

  // an undecoded frame: the canvas is left untouched (transparent black)
  const untouched = canvasOf(() => {});
  // what drawImage of a black frame gives
  const black = canvasOf((ctx, w, h) => { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); });
  // a real frame
  const real = canvasOf((ctx, w, h) => {
    ctx.fillStyle = '#123'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#DDD'; ctx.fillRect(20, 20, 90, 60);
  });
  // a nearly-black frame that still has a rider in it — must NOT be rejected
  const dim = canvasOf((ctx, w, h) => {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#0C0C0C'; ctx.fillRect(30, 30, 60, 40);
  });

  const src = await (await fetch('/js/analysis.js')).text();
  const pageSrc = await (await fetch('/js/pages/analyze.js')).text();
  return {
    untouched: A.hasPicture(untouched.ctx, 240, 135),
    black: A.hasPicture(black.ctx, 240, 135),
    real: A.hasPicture(real.ctx, 240, 135),
    dim: A.hasPicture(dim.ctx, 240, 135),
    // the mechanisms
    primesReaders: (src.match(/await primeVideo\(video\)/g) || []).length,
    waitsForPaint: /await paintedFrame\(video\)/.test(src),
    usesRVFC: /requestVideoFrameCallback/.test(src),
    retriesOnce: /if \(!hasPicture\([\s\S]{0,400}?return \{ fail: "the frame decoded blank/.test(src),
    namesTheReason: /stillsFail/.test(src),
    playerPrimes: /await video\.play\(\); video\.pause\(\)/.test(pageSrc),
    previewPrimes: /await play\.play\(\); play\.pause\(\)/.test(pageSrc),
  };
});

T('an undecoded frame is recognised as having no picture', r.untouched === false, `hasPicture=${r.untouched}`);
T('a solid black frame is too', r.black === false, `hasPicture=${r.black}`);
T('a real frame passes', r.real === true, `hasPicture=${r.real}`);
T('a genuinely dark frame with a rider in it is not thrown away', r.dim === true, `hasPicture=${r.dim}`);
// side clip, front/rear sampler, and once more as the keyframe retry
T('every video reader is primed before it is read', r.primesReaders === 3, `primeVideo calls=${r.primesReaders}`);
T('the still waits for a frame to be presented, not just for the seek',
  r.waitsForPaint && r.usesRVFC, 'paintedFrame via requestVideoFrameCallback');
T('a blank grab yields no still rather than an overlay on black', r.retriesOnce, 'retry once, then report the failure');
T('and the report is told why, instead of the section vanishing', r.namesTheReason, 'stillsFail travels with the report');
T('the report player plays a frame before it paints the overlay', r.playerPrimes);
T('the capture preview does the same', r.previewPrimes);
await b.close();
finish();
