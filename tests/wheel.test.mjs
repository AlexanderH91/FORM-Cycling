/* The wheel is the only ruler in the picture. Draw a bike-shaped scene — a
   wall, a floor, a tyre as a dark ring, spokes, a frame tube across it, a
   rider's leg over part of it — then see whether the detector finds the wheel,
   how big it says it is, and what it makes of a wheel filmed off-square. */
import { browser, BASE, T, finish } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage();
await page.goto(`${BASE}/index.html`);

const r = await page.evaluate(async () => {
  const W = await import('/js/wheel.js');

  /* A scene at 320×240 with a wheel of radius R, squashed horizontally by
     cos(yaw) to stand in for a camera off-square. Deterministic noise. */
  let seed = 3;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const scene = (R, yawDeg, occlude = true) => {
    const cv = document.createElement('canvas'); cv.width = 320; cv.height = 240;
    const g = cv.getContext('2d');
    const sx = Math.cos(yawDeg * Math.PI / 180);
    g.fillStyle = '#d9d4cc'; g.fillRect(0, 0, 320, 240);            // wall
    g.fillStyle = '#8a6b4a'; g.fillRect(0, 190, 320, 50);           // floor
    g.fillStyle = '#3a3a3a'; g.fillRect(0, 175, 320, 15);           // mat
    const cx = 110, cy = 150;
    g.save(); g.translate(cx, cy); g.scale(sx, 1);
    g.strokeStyle = '#1a1a1a'; g.lineWidth = 9;                     // tyre
    g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = '#555'; g.lineWidth = 1;                        // spokes
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) { g.beginPath(); g.moveTo(0, 0); g.lineTo(R * Math.cos(a), R * Math.sin(a)); g.stroke(); }
    g.fillStyle = '#222'; g.beginPath(); g.arc(0, 0, 6, 0, Math.PI * 2); g.fill();  // hub
    g.restore();
    g.strokeStyle = '#151515'; g.lineWidth = 7;                     // frame tubes
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(200, 70); g.lineTo(260, 150); g.stroke();
    if (occlude) {                                                  // a leg over the rim
      g.fillStyle = '#c9a27c'; g.fillRect(cx + R * sx - 12, cy - R - 10, 26, R + 40);
    }
    // sensor noise
    const img = g.getImageData(0, 0, 320, 240);
    for (let i = 0; i < img.data.length; i += 4) { const n = (rnd() - 0.5) * 18; img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n; }
    return img;
  };

  const square = W.findWheel(scene(60, 0));
  const off = W.findWheel(scene(60, 20));
  const big = W.findWheel(scene(85, 0, false));
  const many = W.settleWheel([W.findWheel(scene(60, 0)), W.findWheel(scene(60, 0)), W.findWheel(scene(60, 0))]);
  const cal = W.calibrate(off);
  const nothing = W.findWheel((() => { const c = document.createElement('canvas'); c.width = 320; c.height = 240; const g = c.getContext('2d'); g.fillStyle = '#ccc'; g.fillRect(0, 0, 320, 240); return g.getImageData(0, 0, 320, 240); })());
  return { square, off, big, many, cal, nothing, threshold: W.YAW_RESOLVED_RATIO };
});

const W_cal = (w) => ({ resolved: w.ratio < r.threshold, yawDeg: (Math.acos(Math.min(1, w.ratio)) * 180 / Math.PI).toFixed(0), threshold: r.threshold });
T('a wheel is found in a cluttered side view, with a leg across its rim',
  r.square && Math.abs(r.square.cx - 110) < 4 && Math.abs(r.square.cy - 150) < 4,
  r.square ? `centre (${r.square.cx.toFixed(1)}, ${r.square.cy.toFixed(1)}) vs (110, 150)` : 'not found');
/* The tyre is drawn 9 px wide about R, so its OUTER edge — the one that is
   670 mm on a real wheel — sits at R + 4.5. That is what the detector must
   read, not the tyre's centreline. */
T('and its size is read to the tyre\'s outer edge, within a few per cent',
  r.square && Math.abs(r.square.major - 64.5) / 64.5 < 0.04,
  r.square ? `radius ${r.square.major.toFixed(1)} px vs 64.5` : 'not found');
T('a bigger wheel is found at its own size', r.big && Math.abs(r.big.major - 89.5) / 89.5 < 0.04,
  r.big ? `${r.big.major.toFixed(1)} px vs 89.5` : 'not found');
T('a wheel filmed 20° off-square comes back as an ellipse of the right ratio',
  r.off && Math.abs(r.off.ratio - Math.cos(20 * Math.PI / 180)) < 0.06,
  r.off ? `ratio ${r.off.ratio.toFixed(3)} vs cos 20° = ${Math.cos(20 * Math.PI / 180).toFixed(3)}` : 'not found');
/* Yaw from one ring is coarse by nature: cos is flat near zero, so a pixel
   on the minor axis is five degrees of yaw. Good enough to say "the camera is
   off" and roughly how much; not a number to correct angles with on its own. */
T('a wheel seen 20° off square is resolved as off square', r.cal?.resolved === true, `ratio ${r.cal?.ratio}`);
T('while a square one is not — near square the ellipse cannot say how far', r.square && !W_cal(r.square).resolved,
  r.square ? `ratio ${r.square.ratio.toFixed(3)} reads as ${W_cal(r.square).yawDeg}°, quoted only past ${W_cal(r.square).threshold}` : 'not found');
T('and the camera yaw is read back off it, roughly', r.cal && Math.abs(r.cal.yawDeg - 20) < 7,
  r.cal ? `${r.cal.yawDeg}° vs 20° — a pixel on the short axis is 5° of yaw` : 'no calibration');
T('while its long axis still gives the true diameter, so scale survives the yaw',
  r.off && Math.abs(r.off.major - 64.5) / 64.5 < 0.04, r.off ? `${r.off.major.toFixed(1)} px vs 64.5` : 'not found');
T('several frames of a bike that is not moving settle to one wheel',
  r.many && r.many.frames >= 2 && Math.abs(r.many.major - 64.5) / 64.5 < 0.04,
  r.many ? `${r.many.frames} frames, ${r.many.major.toFixed(1)} px` : 'nothing settled');
T('a blank wall has no wheel in it', r.nothing === null);

await b.close();
finish();
