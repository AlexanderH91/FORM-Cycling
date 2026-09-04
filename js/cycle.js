/* THE STROKE AS A FUNCTION OF CRANK ANGLE, NOT OF TIME.
 *
 * Pedalling repeats. Every joint traces the same path once per revolution, so
 * the honest description of a rider's stroke is not "the frame where the ankle
 * was lowest" but a smooth periodic curve fitted to every frame of the clip.
 *
 * Reading one frame at the extreme has two costs. The frame is one noisy
 * sample, so each stroke's number carries the whole per-frame error of the
 * model. And choosing the frame BY the extreme is itself decided by noise, so
 * the chosen frame leans towards whichever way the noise happened to fall.
 * Fitting a short Fourier series — a constant plus three harmonics — to all two
 * hundred frames and evaluating it at exactly bottom-dead-centre uses every
 * frame to estimate that one number, and has no favourite frame to lean on.
 *
 * Crank angle itself comes from the spindle circle already fitted to the
 * foot's path: the spindle's angle about that circle's centre. Bottom-dead-
 * centre is then a definition rather than a search, and cadence is the slope
 * of crank angle against time — sub-frame, from every frame at once. */

const TAU = Math.PI * 2;

/* Crank angle per frame, unwrapped so it climbs continuously. Image y grows
   downward, so the lowest point of the circle is +90° and the highest −90°;
   `forward` says which horizontal direction the bike faces, so the most
   forward point (3 o'clock) is 0 when forward is +x and π when it is −x. */
export function crankAngles(points, centre) {
  const raw = points.map((p) => (p ? Math.atan2(p.y - centre.cy, p.x - centre.cx) : NaN));
  const out = [];
  let turns = 0, prev = NaN;
  for (const a of raw) {
    if (!Number.isFinite(a)) { out.push(NaN); continue; }
    if (Number.isFinite(prev)) {
      if (a - prev > Math.PI) turns--;
      else if (prev - a > Math.PI) turns++;
    }
    out.push(a + turns * TAU);
    prev = a;
  }
  return out;
}

export const BDC = Math.PI / 2;          // lowest point: image y is largest
export const TDC = -Math.PI / 2;
export const THREE = (forward) => (forward > 0 ? 0 : Math.PI);

/* Least squares fit of  q(θ) = a0 + Σ ak cos kθ + bk sin kθ,  k = 1..K.
   Solved with the normal equations; the design is tiny (2K+1 columns) so a
   plain Gaussian elimination is fine and dependency-free. */
export function harmonic(theta, values, K = 3) {
  const rows = [];
  for (let i = 0; i < theta.length; i++)
    if (Number.isFinite(theta[i]) && Number.isFinite(values[i])) rows.push([theta[i], values[i]]);
  const m = 2 * K + 1;
  if (rows.length < m * 4) return null;

  const basis = (t) => {
    const b = [1];
    for (let k = 1; k <= K; k++) b.push(Math.cos(k * t), Math.sin(k * t));
    return b;
  };
  const A = Array.from({ length: m }, () => new Float64Array(m + 1));
  for (const [t, v] of rows) {
    const b = basis(t);
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) A[i][j] += b[i] * b[j];
      A[i][m] += b[i] * v;
    }
  }
  // Gaussian elimination with partial pivoting.
  for (let c = 0; c < m; c++) {
    let p = c;
    for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < m; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let j = c; j <= m; j++) A[r][j] -= f * A[c][j];
    }
  }
  const coef = A.map((row, i) => row[m] / row[i]);
  const at = (t) => basis(t).reduce((s, b, i) => s + b * coef[i], 0);

  // Residuals: how far the frames sit from the curve, which is the rider's
  // own stroke-to-stroke variation plus the model's per-frame noise.
  const res = rows.map(([t, v]) => v - at(t));
  const sd = Math.sqrt(res.reduce((s, r) => s + r * r, 0) / Math.max(1, res.length - m));
  return { at, coef, sd, n: rows.length,
    /* Spread of the frames within a window of the given angle — the honest
       per-stroke variation at the moment being reported, rather than across
       the whole revolution. */
    sdNear: (t0, halfWidth = Math.PI / 8) => {
      const near = rows.filter(([t]) => {
        const d = Math.abs(((t - t0) % TAU + TAU + Math.PI) % TAU - Math.PI);
        return d <= halfWidth;
      }).map(([t, v]) => v - at(t));
      if (near.length < 4) return sd;
      const mu = near.reduce((s, r) => s + r, 0) / near.length;
      return Math.sqrt(near.reduce((s, r) => s + (r - mu) ** 2, 0) / (near.length - 1));
    },
  };
}

/* Revolutions per minute from the unwrapped angle against time — a straight
   line through every frame, so a single mis-timed frame cannot set it. */
export function cadenceFrom(theta, times) {
  const pts = [];
  for (let i = 0; i < theta.length; i++)
    if (Number.isFinite(theta[i]) && Number.isFinite(times[i])) pts.push([times[i], theta[i]]);
  if (pts.length < 10) return null;
  const n = pts.length;
  const mt = pts.reduce((s, p) => s + p[0], 0) / n, ma = pts.reduce((s, p) => s + p[1], 0) / n;
  let num = 0, den = 0;
  for (const [t, a] of pts) { num += (t - mt) * (a - ma); den += (t - mt) ** 2; }
  if (den < 1e-9) return null;
  const radPerSec = num / den;
  return { rpm: Math.abs(radPerSec) / TAU * 60, direction: Math.sign(radPerSec),
           revolutions: Math.abs(pts.at(-1)[1] - pts[0][1]) / TAU };
}

/* The frame nearest a given crank angle on each revolution — for the picture,
   which still has to be a real frame, even though the number no longer is. */
export function framesAt(theta, target) {
  const out = [];
  let bestI = -1, bestD = Infinity, lastTurn = null;
  for (let i = 0; i < theta.length; i++) {
    const t = theta[i];
    if (!Number.isFinite(t)) continue;
    const turn = Math.floor((t - target) / TAU + 0.5);
    if (lastTurn !== null && turn !== lastTurn) { if (bestI >= 0) out.push(bestI); bestI = -1; bestD = Infinity; }
    lastTurn = turn;
    const d = Math.abs(t - (target + turn * TAU));
    if (d < bestD) { bestD = d; bestI = i; }
  }
  if (bestI >= 0) out.push(bestI);
  return out;
}
