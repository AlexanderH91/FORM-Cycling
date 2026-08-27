import { browser, BASE, T, finish, OUT } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage();
await page.goto(`${BASE}/index.html`);

const r = await page.evaluate(async () => {
  const { fitContain } = await import('/js/pages/analyze.js');
  const map = (box, p) => [box.x + p.x * box.w, box.y + p.y * box.h];
  return {
    // box matches the frame exactly: no letterbox, centre maps to centre
    exact: (() => { const bx = fitContain(360, 640, 1080, 1920); return { bx, mid: map(bx, {x:.5,y:.5}) }; })(),
    // portrait clip in a landscape box: pillarboxed, picture narrower than box
    pillar: (() => { const bx = fitContain(360, 200, 1080, 1920); return { bx, mid: map(bx, {x:.5,y:.5}) }; })(),
    // landscape clip in a tall box: letterboxed
    letter: (() => { const bx = fitContain(360, 640, 1920, 1080); return { bx, mid: map(bx, {x:.5,y:.5}) }; })(),
    // a joint at the frame's top-left must land on the picture's corner, not the box's
    corner: (() => { const bx = fitContain(360, 640, 1920, 1080); return map(bx, {x:0,y:0}); })(),
    noMeta: fitContain(360, 640, 0, 0),
    noBox: fitContain(0, 0, 1080, 1920),
  };
});
T('no letterbox: picture fills the box', Math.abs(r.exact.bx.w - 360) < .01 && Math.abs(r.exact.bx.h - 640) < .01,
  `${r.exact.bx.w}x${r.exact.bx.h}`);
T('centre of frame maps to centre of picture', Math.abs(r.exact.mid[0]-180)<.01 && Math.abs(r.exact.mid[1]-320)<.01,
  `(${r.exact.mid[0]}, ${r.exact.mid[1]})`);
T('portrait clip pillarboxes, centre still centred', r.pillar.bx.w < 360 && Math.abs(r.pillar.mid[0]-180)<.01,
  `picture ${r.pillar.bx.w.toFixed(1)}x${r.pillar.bx.h} in a 360x200 box`);
T('landscape clip letterboxes vertically', r.letter.bx.h < 640 && r.letter.bx.y > 0,
  `picture ${r.letter.bx.w}x${r.letter.bx.h.toFixed(1)} offset y=${r.letter.bx.y.toFixed(1)}`);
T('frame corner lands on the picture, not the box', r.corner[1] > 0,
  `top-left maps to y=${r.corner[1].toFixed(1)}, not 0 — this is what was misplacing the skeleton`);
T('falls back sanely before metadata arrives', r.noMeta.w === 360 && r.noBox === null,
  `noMeta=${r.noMeta.w}px  noBox=${r.noBox}`);

const src = await (await page.evaluate(() => fetch('/js/pages/analyze.js').then(r => r.text()))) ;
T('canvas resizes on height change too', /canvas\.height !== Math\.round\(bh \* dpr\)/.test(src), 'height compared, not just width');
T('canvas is device-pixel sharp', /devicePixelRatio/.test(src), 'dpr applied');
T('preview seeks off zero to paint a frame', /currentTime = 0\.03/.test(src), 'forces a decoded frame');
T('records at high bitrate', /videoBitsPerSecond: 12_000_000/.test(src), '12 Mbps');
T('asks the camera for 1080p60', /ideal: 1920/.test(src) && /ideal: 60/.test(src), '1920x1080 @60');
T('every camera constraint is soft', !/min: 30|exact:/.test(src), 'no hard constraints to throw on');
T('falls back to a plain rear camera if refused', /facingMode: "environment" \}, audio: false \}\)\)/.test(src), 'retry without the quality request');
await b.close();
finish();
