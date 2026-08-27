/* An end-to-end smoke test of the real analysis pipeline.
 *
 * Every other suite here tests a piece. This one calls analyzeSideClip on an
 * actual clip and checks it comes back with an answer of some kind — which is
 * what catches the class of bug the unit tests cannot see: a variable used
 * before it is declared, a model that fails to load, a seek that never
 * returns. One of those shipped in this very change (refine(bdc) sat above
 * bdc's own declaration, a ReferenceError on every analysis) and no existing
 * test could have caught it. */
import { browser, BASE, T, finish } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${BASE}/index.html`);

const r = await page.evaluate(async () => {
  const A = await import('/js/analysis.js');
  const C = await import('/js/config.js');

  // The sweep model has to be servable from the app itself, not from a CDN.
  const modelUrl = C.POSE_MODEL.url('lite');
  const head = await fetch(modelUrl, { method: 'GET' });
  const local = new URL(modelUrl).origin === location.origin;

  // A short clip with no rider in it. The pipeline should GATE, not throw.
  const c = document.createElement('canvas'); c.width = 320; c.height = 240;
  const g = c.getContext('2d');
  const rec = new MediaRecorder(c.captureStream(30), { videoBitsPerSecond: 2_000_000 });
  const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
  rec.start();
  const t0 = performance.now();
  await new Promise((done) => {
    const tick = () => {
      g.fillStyle = '#204060'; g.fillRect(0, 0, 320, 240);
      g.fillStyle = '#DDD'; g.fillRect((performance.now() - t0) / 12, 100, 40, 40);
      if (performance.now() - t0 < 2500) requestAnimationFrame(tick); else done();
    };
    tick();
  });
  await new Promise((res) => { rec.onstop = res; rec.stop(); });
  const blob = new Blob(chunks, { type: chunks[0]?.type || 'video/webm' });

  const seen = [];
  let out, threw = null;
  const started = performance.now();
  try { out = await A.analyzeSideClip(blob, [0, 2.4], (pct, msg) => seen.push(msg ?? pct)); }
  catch (e) { threw = `${e.name}: ${e.message}`; }
  return {
    modelOk: head.ok, modelLocal: local, modelUrl,
    threw,
    gated: !!out?.gate,
    gate: out?.gate?.slice(0, 60),
    hasCapture: !!out?.capture,
    ms: Math.round(performance.now() - started),
    // nothing may be left behind in the page
    strayVideos: document.querySelectorAll('video').length,
    spreadEven: JSON.stringify(A.spread([0,1,2,3,4,5,6,7,8,9], 3)),
    spreadShort: JSON.stringify(A.spread([4,5], 6)),
    spreadOne: JSON.stringify(A.spread([1,2,3], 1)),
  };
});

T('the sweep model is served by the app, not a CDN', r.modelLocal && r.modelOk, r.modelUrl.replace(/^https?:\/\/[^/]+/, ''));
T('a real analysis runs end to end without throwing', r.threw === null, r.threw ?? `finished in ${r.ms}ms`);
T('a clip with no rider gates instead of inventing numbers', r.gated, r.gate ? `"${r.gate}…"` : 'no gate');
T('and the gate still carries the capture grade', r.hasCapture);
T('the analysis leaves no video elements behind', r.strayVideos === 0, `stray=${r.strayVideos}`);
T('refinement samples strokes across the clip, not just the first few',
  r.spreadEven === '[0,5,9]', `spread(0..9, 3) = ${r.spreadEven}`);
T('and copes with fewer strokes than the budget', r.spreadShort === '[4,5]' && r.spreadOne === '[2]',
  `short=${r.spreadShort} one=${r.spreadOne}`);
T('no uncaught page errors during the run', errs.length === 0, errs.join(' | ') || 'clean');
await b.close();
finish();
