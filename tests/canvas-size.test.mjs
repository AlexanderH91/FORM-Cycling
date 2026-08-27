import { browser, BASE, T, finish, OUT } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 393, height: 900 } });
await page.goto(`${BASE}/#/login`);
await page.waitForSelector('#send');

/* The real sequence: a <video> with height:auto is 150px tall before its
   metadata arrives, then jumps to its true height. The old code compared only
   the WIDTH, so the canvas bitmap stayed at the pre-metadata height while
   being displayed at the real one. */
const r = await page.evaluate(() => {
  const el = document.createElement('div');
  el.innerHTML = `<div class="glass player" style="width:359px"><div class="stagewrap">
    <video id="v" class="shot"></video><canvas id="c"></canvas></div></div>`;
  document.getElementById('view').appendChild(el);
  const v = document.getElementById('v'), c = document.getElementById('c');

  const beforeH = v.clientHeight;                 // no metadata yet
  // old logic
  const oldResize = (w, h) => { if (c.width !== w) { c.width = w; c.height = h; } };
  oldResize(359, beforeH);
  const oldAfterFirst = { w: c.width, h: c.height };
  oldResize(359, 202);                            // metadata arrives, real height
  const oldAfterMeta = { w: c.width, h: c.height };

  // new logic
  c.width = 0; c.height = 0;
  const dpr = 1;
  const newResize = (w, h) => {
    if (c.width !== Math.round(w*dpr) || c.height !== Math.round(h*dpr)) { c.width = Math.round(w*dpr); c.height = Math.round(h*dpr); }
  };
  newResize(359, beforeH);
  newResize(359, 202);
  const newAfterMeta = { w: c.width, h: c.height };

  // what that does to a joint at 80% down the frame
  const yTrue = 0.8 * 202;
  const yOld = 0.8 * oldAfterMeta.h * (202 / oldAfterMeta.h) * (oldAfterMeta.h / 202); // drawn into a stale bitmap, stretched back
  const drawnOld = (0.8 * oldAfterMeta.h) * (202 / oldAfterMeta.h);
  return { beforeH, oldAfterFirst, oldAfterMeta, newAfterMeta,
           staleScale: +(oldAfterMeta.h / 202).toFixed(3),
           yTrue: +yTrue.toFixed(1),
           yDrawnOld: +(0.8 * oldAfterMeta.h).toFixed(1) };
});
T('a video is 150px tall before metadata', r.beforeH === 150, `clientHeight=${r.beforeH}px`);
T('old logic kept the stale height after metadata', r.oldAfterMeta.h === r.beforeH,
  `canvas stayed ${r.oldAfterMeta.w}x${r.oldAfterMeta.h} while displayed 359x202`);
T('new logic picks up the real height', r.newAfterMeta.h === 202, `canvas ${r.newAfterMeta.w}x${r.newAfterMeta.h}`);
T('that mis-scaled every point vertically', r.staleScale < 0.8,
  `bitmap was ${(r.staleScale*100).toFixed(0)}% of the displayed height — a joint 80% down drew at ${r.yDrawnOld}px of a ${r.yTrue}px target`);
await b.close();
finish();
