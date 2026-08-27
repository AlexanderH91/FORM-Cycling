/* The side view measured whichever leg the model happened to see best in each
   individual frame. A rider's legs are 180 degrees out of phase, so a swap
   mid-clip reads the far leg's TOP-of-stroke angle as the near leg's
   BOTTOM-of-stroke angle. This suite holds the leg still for the whole clip
   and shows what the per-frame version did to the numbers. */
import { browser, BASE, T, finish } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage();
await page.goto(`${BASE}/index.html`);

const r = await page.evaluate(async () => {
  const A = await import('/js/analysis.js');

  // A clip of a rider: the near (left) leg is generally better seen, but on the
  // frames where the far leg swings up it briefly wins on visibility.
  const N = 120;
  const frames = [];
  const trueKnee = [];                       // the LEFT leg's real bend, per frame
  for (let i = 0; i < N; i++) {
    const phase = (i / N) * Math.PI * 8;
    const left  = 35 + 25 * Math.cos(phase);          // 10°..60°, bottom of stroke at 35-ish
    const right = 35 + 25 * Math.cos(phase + Math.PI); // exactly out of phase
    trueKnee.push(left);
    /* The realistic case, and the damaging one: when the near leg reaches the
       bottom it is extended down behind the cranks, and the far leg is swinging
       up into clear view. So the model prefers the far leg at exactly the
       moments the bottom-of-stroke angle is being read. */
    const farWins = Math.cos(phase) < -0.5;
    const vis = (v) => ({ visibility: v });
    frames.push({
      L: { hip: vis(farWins ? 0.55 : 0.95), knee: vis(farWins ? 0.55 : 0.95), ankle: vis(farWins ? 0.55 : 0.95) },
      R: { hip: vis(farWins ? 0.85 : 0.50), knee: vis(farWins ? 0.85 : 0.50), ankle: vis(farWins ? 0.85 : 0.50) },
      left, right,
    });
  }

  const { side, flipped } = A.dominantSide(frames);
  // what the shipped code measured: whichever side won THIS frame
  const perFrame = frames.map((f) =>
    (f.L.knee.visibility >= f.R.knee.visibility ? f.left : f.right));
  const locked = frames.map((f) => (side === 'L' ? f.left : f.right));

  const sd = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length;
                      return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); };
  const median = (a) => { const q = [...a].sort((x, y) => x - y); return q[q.length >> 1]; };
  // The frames the report actually measures: the near leg at the bottom.
  const atBottom = trueKnee.map((v, i) => (v < 12 ? i : -1)).filter((i) => i >= 0);
  const read = (series) => atBottom.map((i) => series[i]);

  // pickSide honours a lock, and picks sensibly when not given one
  const lm = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0.5 }));
  lm[23] = { x: 0.1, y: 0.1, visibility: 0.9 };   // left hip, clearly seen
  lm[24] = { x: 0.2, y: 0.2, visibility: 0.2 };   // right hip, not
  return {
    side, flipped, N,
    bottomFrames: atBottom.length,
    trueBDC: +median(read(trueKnee)).toFixed(1),
    lockedBDC: +median(read(locked)).toFixed(1),
    perFrameBDC: +median(read(perFrame)).toFixed(1),
    lockedBDCSd: +sd(read(locked)).toFixed(2),
    perFrameBDCSd: +sd(read(perFrame)).toFixed(2),
    forcedR: A.pickSide(lm, 'R').hip.x,
    forcedL: A.pickSide(lm, 'L').hip.x,
    unforced: A.pickSide(lm).hip.x,
  };
});

T('one leg is chosen for the whole clip', r.side === 'L' || r.side === 'R', `side=${r.side}`);
T('and the frames that disagreed are counted, not hidden',
  r.flipped > 0 && r.flipped < r.N, `${r.flipped} of ${r.N} frames would have gone the other way`);
T('locking the leg reads the real bottom-of-stroke angle',
  Math.abs(r.lockedBDC - r.trueBDC) < 0.5, `locked ${r.lockedBDC}° vs true ${r.trueBDC}°`);
T('the per-frame version read the OTHER leg at the top of its stroke instead',
  r.perFrameBDC - r.trueBDC > 20, `per-frame ${r.perFrameBDC}° vs true ${r.trueBDC}°`);
/* The worst part: because the swap happens at the SAME point in every stroke,
   the wrong reading is a steady one. It carries a small spread, so it looks
   confident, and neither averaging strokes nor pooling rides would ever catch
   it — a systematic error is invisible to both. */
T('and the wrong answer looked just as confident as the right one',
  r.perFrameBDCSd < 1 && r.lockedBDCSd < 1,
  `per-frame ${r.perFrameBDC}° ±${r.perFrameBDCSd}° vs locked ${r.lockedBDC}° ±${r.lockedBDCSd}°`);
T('a locked side is honoured over visibility', r.forcedR === 0.2 && r.forcedL === 0.1,
  `L->${r.forcedL} R->${r.forcedR}`);
T('with no lock it still falls back to the better-seen side', r.unforced === 0.1);
await b.close();
finish();
