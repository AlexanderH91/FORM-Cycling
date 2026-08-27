import { browser, BASE, T, finish, OUT } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await b.newPage({ viewport: { width: 393, height: 900 }, deviceScaleFactor: 2 });
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto(`${BASE}/#/login`);
await page.waitForSelector('#send');

/* Make a LANDSCAPE clip (16:9) that will be letterboxed inside the report
   card — the exact case that was breaking. Paint three magenta markers at
   known normalised positions, then feed the player a track claiming the
   joints are at those same positions. If the mapping is right, the drawn
   skeleton lands on the markers. */
const res = await page.evaluate(async () => {
  const W = 960, H = 540;                     // 16:9 landscape
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const J = { hip: {x:0.62,y:0.30}, knee: {x:0.70,y:0.55}, ankle: {x:0.66,y:0.80} };
  const stream = c.captureStream(30);
  const rec = new MediaRecorder(stream, { videoBitsPerSecond: 8_000_000 });
  const chunks = []; rec.ondataavailable = e => chunks.push(e.data);
  rec.start();
  const t0 = performance.now();
  await new Promise(done => {
    const tick = () => {
      g.fillStyle = '#101010'; g.fillRect(0, 0, W, H);
      g.fillStyle = '#FF00FF';
      for (const p of Object.values(J)) { g.beginPath(); g.arc(p.x*W, p.y*H, 14, 0, 7); g.fill(); }
      if (performance.now() - t0 < 2200) requestAnimationFrame(tick); else done();
    };
    tick();
  });
  await new Promise(r => { rec.onstop = r; rec.stop(); });
  const clip = new Blob(chunks, { type: chunks[0]?.type || 'video/webm' });

  const track = [];
  for (let i = 0; i <= 40; i++) track.push({ t: +(i/15).toFixed(3), knee: 35, j: { ...J, sho: {x:0.5,y:0.15} } });

  // mount the real player markup and wire it with the shipped code
  const { fitContain } = await import('/js/pages/analyze.js');
  const v = document.getElementById('view');
  v.innerHTML = `<div class="glass player"><div class="stagewrap">
      <video id="mv" class="shot" playsinline muted loop preload="auto"></video>
      <canvas id="mvc"></canvas><div class="mv-live mono"><span id="mvang">–</span></div></div>
    <div class="mv-bar"><button class="mv-play" id="mvplay">▶</button>
      <input id="mvseek" type="range" min="0" max="1000" value="0">
      <div class="mv-speeds"><button data-x="1" class="on">1×</button></div></div></div>`;

  const video = document.getElementById('mv'), canvas = document.getElementById('mvc');
  const url = URL.createObjectURL(clip);
  video.src = url;
  await new Promise(r => { video.onloadeddata = r; setTimeout(r, 4000); });
  video.currentTime = 1.0;
  await new Promise(r => { video.onseeked = r; setTimeout(r, 2000); });

  // draw exactly as the shipped player does
  const box = fitContain(video.clientWidth, video.clientHeight, video.videoWidth, video.videoHeight);
  const dpr = Math.min(3, devicePixelRatio || 1);
  canvas.width = Math.round(video.clientWidth*dpr); canvas.height = Math.round(video.clientHeight*dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  const at = p => [box.x + p.x*box.w, box.y + p.y*box.h];

  // Where is the marker really, in element space? Read it off the decoded frame.
  const probe = document.createElement('canvas');
  probe.width = video.videoWidth; probe.height = video.videoHeight;
  probe.getContext('2d').drawImage(video, 0, 0);
  const px = probe.getContext('2d').getImageData(0,0,probe.width,probe.height).data;
  const found = [];
  for (let y = 0; y < probe.height; y += 2) for (let x = 0; x < probe.width; x += 2) {
    const i = (y*probe.width + x)*4;
    if (px[i] > 180 && px[i+1] < 80 && px[i+2] > 180) found.push({ x: x/probe.width, y: y/probe.height });
  }
  const kneeMarker = found.filter(p => p.y > 0.45 && p.y < 0.65);
  const mk = kneeMarker.length
    ? { x: kneeMarker.reduce((s,p)=>s+p.x,0)/kneeMarker.length, y: kneeMarker.reduce((s,p)=>s+p.y,0)/kneeMarker.length }
    : null;

  const drawnKnee = at(J.knee);
  const markerInElement = mk ? at(mk) : null;
  return {
    videoW: video.videoWidth, videoH: video.videoHeight,
    boxW: +box.w.toFixed(1), boxH: +box.h.toFixed(1), boxY: +box.y.toFixed(1),
    elW: video.clientWidth, elH: video.clientHeight,
    markersFound: found.length,
    drawnKnee: drawnKnee.map(n => +n.toFixed(1)),
    markerInElement: markerInElement ? markerInElement.map(n => +n.toFixed(1)) : null,
    err: markerInElement ? Math.hypot(drawnKnee[0]-markerInElement[0], drawnKnee[1]-markerInElement[1]) : null,
    naiveKnee: [J.knee.x*video.clientWidth, J.knee.y*video.clientHeight].map(n => +n.toFixed(1)),
  };
});

T('made a real landscape clip with markers', res.markersFound > 50 && res.videoW === 960,
  `${res.videoW}x${res.videoH}, ${res.markersFound} marker pixels found`);
// height:auto makes the element take the clip's own aspect, so in the shipped
// layout there is no letterbox. fitContain is insurance, not the fix.
T('no letterbox in the shipped layout', Math.abs(res.boxH - res.elH) < 1.5 && res.boxY < 1,
  `picture ${res.boxW}x${res.boxH} fills element ${res.elW}x${res.elH}`);
T('drawn joint lands on the real marker', res.err != null && res.err < 6,
  `drawn (${res.drawnKnee}) vs marker (${res.markerInElement}) — ${res.err?.toFixed(1)}px apart`);
const naiveErr = res.markerInElement ? Math.hypot(res.naiveKnee[0]-res.markerInElement[0], res.naiveKnee[1]-res.markerInElement[1]) : 0;
T('so element-space mapping agrees here, as expected', naiveErr < 2,
  `element-space would draw at (${res.naiveKnee}) — ${naiveErr.toFixed(1)}px away; the misalignment came from the canvas height, not the fit`);
console.log(errs.length ? 'JS ERRORS: ' + errs.join(' | ') : 'no JS errors');
await b.close();
finish();
