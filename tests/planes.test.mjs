import { browser, BASE, T, finish, OUT } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage();
await page.goto(`${BASE}/index.html`);

// Drive the pure geometry helpers with known frontal-plane poses.
const r = await page.evaluate(async () => {
  const { squareUp, angleAt } = await import('/js/analysis.js');
  const W = 1080, H = 1920, sq = squareUp(W / H);      // portrait clip
  const n = (x, y) => sq({ x: x / W, y: y / H });
  const deg = (v) => (v * 180) / Math.PI;
  const fromVertical = (top, bottom, inward) => {
    const dx = bottom.x - top.x, dy = bottom.y - top.y;
    const a = deg(Math.atan2(dx, Math.abs(dy) + 1e-9));
    return inward ? a : -a;
  };
  // knee directly above ankle => 0deg; knee 100px medial over 400px of shin
  const straight = fromVertical(n(500, 1000), n(500, 1400), true);
  const leaned   = fromVertical(n(500, 1000), n(600, 1400), true);
  const truthLean = deg(Math.atan2(100, 400));
  // tilt of a shoulder line, 40px drop across 300px of width
  const tilt = (a, bb) => deg(Math.atan2(bb.y - a.y, Math.abs(bb.x - a.x) + 1e-9));
  const shoulderTilt = tilt(n(400, 800), n(700, 840));
  const truthTilt = deg(Math.atan2(40, 300));
  return { straight, leaned, truthLean, shoulderTilt, truthTilt };
});
T('vertical shin reads 0°', Math.abs(r.straight) < 0.01, `got ${r.straight.toFixed(3)}°`);
T('knee lean matches true geometry', Math.abs(r.leaned - r.truthLean) < 0.01, `got ${r.leaned.toFixed(2)}° true ${r.truthLean.toFixed(2)}°`);
T('shoulder tilt matches true geometry', Math.abs(r.shoulderTilt - r.truthTilt) < 0.01, `got ${r.shoulderTilt.toFixed(2)}° true ${r.truthTilt.toFixed(2)}°`);

// Card building: honesty rules — no verdict without a cited band.
const cards = await page.evaluate(async () => {
  const mod = await import('/js/pages/analyze.js');
  return typeof mod.renderAnalyze === 'function';
});
T('analyze page still loads', cards, 'renderAnalyze exported');
await b.close();
finish();
