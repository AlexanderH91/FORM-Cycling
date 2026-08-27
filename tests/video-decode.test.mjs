import { browser, BASE, T, finish } from './lib.mjs';
const chromium = await browser();

/* Two mechanisms the report and the capture card both depend on, each of
   which shipped broken:
   1. A display:none <video> never decodes, so a clip loaded while hidden
      shows a black rectangle behind a play button however you seek it.
   2. A one-off backward seek needs a longer budget than a step inside the
      sampling loop — the loop's budget silently returned null for every
      keyframe and the report lost its stills. */

const b = await chromium.launch();
const page = await b.newPage();
await page.goto(`${BASE}/index.html`);

const r = await page.evaluate(async () => {
  // build a clip whose frames are unmistakably not black
  const c = document.createElement('canvas'); c.width = 320; c.height = 180;
  const g = c.getContext('2d');
  const rec = new MediaRecorder(c.captureStream(30), { videoBitsPerSecond: 4_000_000 });
  const chunks = []; rec.ondataavailable = e => chunks.push(e.data);
  rec.start();
  const t0 = performance.now();
  await new Promise(done => {
    const tick = () => {
      g.fillStyle = '#00FF88'; g.fillRect(0, 0, 320, 180);
      if (performance.now() - t0 < 1600) requestAnimationFrame(tick); else done();
    };
    tick();
  });
  await new Promise(r2 => { rec.onstop = r2; rec.stop(); });
  const url = URL.createObjectURL(new Blob(chunks, { type: chunks[0]?.type || 'video/webm' }));

  const sample = (v) => {
    const p = document.createElement('canvas');
    p.width = v.videoWidth || 320; p.height = v.videoHeight || 180;
    const px = p.getContext('2d');
    try { px.drawImage(v, 0, 0); } catch { return null; }
    const d = px.getImageData(p.width >> 1, p.height >> 1, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2] };
  };
  const settle = (v, t, ms) => new Promise(res => {
    let done = false; const fin = ok => { if (!done) { done = true; res(ok); } };
    v.addEventListener('seeked', () => fin(true), { once: true });
    setTimeout(() => fin(false), ms);
    v.currentTime = t;
  });

  // A: hidden while loading — the shipped bug
  const hidden = document.createElement('video');
  hidden.muted = true; hidden.playsInline = true; hidden.preload = 'auto';
  hidden.style.display = 'none';
  document.body.appendChild(hidden);
  hidden.src = url;
  await new Promise(res => { hidden.onloadeddata = res; setTimeout(res, 3000); });
  await settle(hidden, 0.03, 2000);
  const whileHidden = sample(hidden);

  // B: on screen before loading — the fix
  const shown = document.createElement('video');
  shown.muted = true; shown.playsInline = true; shown.preload = 'auto';
  document.body.appendChild(shown);
  shown.src = url; shown.load();
  await new Promise(res => { shown.onloadeddata = res; setTimeout(res, 3000); });
  await settle(shown, 0.03, 2000);
  const whileShown = sample(shown);

  return { whileHidden, whileShown, dims: [shown.videoWidth, shown.videoHeight] };
});

const green = (p) => p && p.g > 120 && p.r < 120;
T('a visible video decodes a real frame', green(r.whileShown),
  `centre pixel rgb(${r.whileShown?.r},${r.whileShown?.g},${r.whileShown?.b}) at ${r.dims.join('x')}`);
T('a hidden one may not — which is why the card went black',
  true, `hidden gave rgb(${r.whileHidden?.r},${r.whileHidden?.g},${r.whileHidden?.b}); the fix shows the element before loading`);

const src = await page.evaluate(async (b) => (await fetch(b + '/js/pages/analyze.js')).text(), BASE);
T('clip is unhidden before its source is set',
  src.indexOf('play.classList.remove("hidden")') < src.indexOf('play.src = url'), 'order in showClip');
T('load() is called so preload actually starts', /play\.load\(\)/.test(src), 'play.load()');

const asrc = await page.evaluate(async (b) => (await fetch(b + '/js/analysis.js')).text(), BASE);
T('seek budget is per-call, not one number for every seek', /function seekTo\(video, t, budgetMs = 2500\)/.test(asrc), 'budgetMs parameter');
T('keyframes rewind before seeking to the frame', /seekTo\(video, 0, 6000\)/.test(asrc), 'rewind first');
T('keyframe seek gets a one-off budget', /seekTo\(video, t, 8000\)/.test(asrc), '8s, vs 2.5s inside the loop');
await b.close();
finish();
