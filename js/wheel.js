/* THE WHEEL IS THE ONLY RULER IN THE PICTURE.
 *
 * Everything the app measures is read off a body that changes shape every
 * frame. The bike does not. A road wheel is about 670 mm across whichever bike
 * it is, it is the largest hard-edged shape in a side view, and on a trainer it
 * does not move. Find it and you have millimetres per pixel with nothing
 * assumed about the rider — and, because a circle seen off-square is an
 * ellipse, the camera's yaw from the ratio of its axes.
 *
 * No model, no download: greyscale, a Sobel edge pass, and a Hough vote in
 * which every edge pixel nominates the centres it could belong to along its own
 * gradient. The best-supported centre and radius is the wheel; a least-squares
 * ellipse through the edge points near it is the refinement. */

/* Sobel edges on a greyscale copy, returning points with gradient direction.
   `step` decimates so a phone frame does not mean a million votes. */
export function edges(img, { threshold = 0.18, step = 2 } = {}) {
  const { width: w, height: h, data } = img;
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) g[j] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
  const pts = [];
  let maxMag = 0;
  const mags = [];
  for (let y = 1; y < h - 1; y += step) {
    for (let x = 1; x < w - 1; x += step) {
      const i = y * w + x;
      const gx = -g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1] + g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1];
      const gy = -g[i - w - 1] - 2 * g[i - w] - g[i - w + 1] + g[i + w - 1] + 2 * g[i + w] + g[i + w + 1];
      const m = Math.hypot(gx, gy);
      if (m > maxMag) maxMag = m;
      mags.push({ x, y, gx, gy, m });
    }
  }
  const cut = threshold * maxMag;
  for (const p of mags) if (p.m >= cut) pts.push({ x: p.x, y: p.y, nx: p.gx / p.m, ny: p.gy / p.m });
  return pts;
}

/* Gradient Hough for circles. Each edge point votes for the centre that would
   sit `r` along its gradient, in both directions (a dark tyre on a light wall
   and a light rim on a dark tyre point opposite ways). The accumulator is
   coarse on purpose — `cell` pixels — because the fit afterwards is what gives
   precision; the vote only has to find the right neighbourhood. */
export function houghCircles(pts, w, h, { minR, maxR, rStep = 2, cell = 3, top = 3 } = {}) {
  const cw = Math.ceil(w / cell), ch = Math.ceil(h / cell);
  const nr = Math.floor((maxR - minR) / rStep) + 1;
  const acc = new Uint16Array(cw * ch * nr);
  for (const p of pts) {
    for (let k = 0; k < nr; k++) {
      const r = minR + k * rStep;
      for (const s of [1, -1]) {
        const cx = p.x + s * r * p.nx, cy = p.y + s * r * p.ny;
        if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
        acc[(k * ch + Math.floor(cy / cell)) * cw + Math.floor(cx / cell)]++;
      }
    }
  }
  /* Votes scale with circumference, so normalise by radius or the biggest
     radius always wins whatever the picture shows. */
  const found = [];
  for (let k = 0; k < nr; k++) {
    const r = minR + k * rStep;
    for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
      const v = acc[(k * ch + j) * cw + i] / r;
      if (v > 0.02) found.push({ cx: (i + 0.5) * cell, cy: (j + 0.5) * cell, r, score: v });
    }
  }
  found.sort((a, b) => b.score - a.score);
  // Keep the best of each distinct neighbourhood.
  const out = [];
  for (const f of found) {
    if (out.some((o) => Math.hypot(o.cx - f.cx, o.cy - f.cy) < o.r * 0.5 && Math.abs(o.r - f.r) < o.r * 0.3)) continue;
    out.push(f);
    if (out.length >= top) break;
  }
  return out;
}

/* Direct least-squares conic through points near a candidate circle, then the
   ellipse it describes. The fit is the general conic  Ax² + Bxy + Cy² + Dx +
   Ey + F = 0  with A + C = 1 to fix the scale, which is linear and solvable
   with normal equations. */
export function fitEllipse(pts) {
  if (pts.length < 20) return null;
  // Centre the data for conditioning.
  const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length, my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  // Unknowns: A, B, D, E, F with C = 1 − A.  Row: A(x²−y²) + Bxy + Dx + Ey + F = −y²
  const M = Array.from({ length: 5 }, () => new Float64Array(6));
  for (const p of pts) {
    const x = p.x - mx, y = p.y - my;
    const row = [x * x - y * y, x * y, x, y, 1], rhs = -y * y;
    for (let i = 0; i < 5; i++) { for (let j = 0; j < 5; j++) M[i][j] += row[i] * row[j]; M[i][5] += row[i] * rhs; }
  }
  for (let c = 0; c < 5; c++) {
    let p = c;
    for (let r = c + 1; r < 5; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < 5; r++) { if (r === c) continue; const f = M[r][c] / M[c][c]; for (let j = c; j < 6; j++) M[r][j] -= f * M[c][j]; }
  }
  const [A, B, D, E, F] = M.map((row, i) => row[5] / row[i]);
  const C = 1 - A;
  // Centre of the conic, then axes from the eigenvalues of the quadratic part.
  const det = 4 * A * C - B * B;
  if (det <= 1e-12) return null;                       // not an ellipse
  const cx = (B * E - 2 * C * D) / det, cy = (B * D - 2 * A * E) / det;
  const k = -(A * cx * cx + B * cx * cy + C * cy * cy + D * cx + E * cy + F);
  if (k <= 0) return null;
  const tr = A + C, disc = Math.sqrt((A - C) * (A - C) + B * B);
  const l1 = (tr - disc) / 2, l2 = (tr + disc) / 2;   // l1 ≤ l2
  if (l1 <= 0) return null;
  const major = Math.sqrt(k / l1), minor = Math.sqrt(k / l2);
  const angle = 0.5 * Math.atan2(B, A - C);            // of the major axis
  return { cx: cx + mx, cy: cy + my, major, minor, angle, ratio: minor / major };
}

/* The wheel in one frame: the best-supported circle, refined to an ellipse
   through the edge points within a band of it. */
export function findWheel(img, opts = {}) {
  const { width: w, height: h } = img;
  const minR = opts.minR ?? Math.round(Math.min(w, h) * 0.10);
  const maxR = opts.maxR ?? Math.round(Math.min(w, h) * 0.45);
  const pts = edges(img, opts);
  if (pts.length < 200) return null;
  const cands = houghCircles(pts, w, h, { minR, maxR, ...opts });
  for (const c0 of cands) {
    /* The Hough centre is only as good as its cell — a few pixels out. From an
       off-centre point the ring's radii smear over a wide range and the two
       tyre edges blur into one, so the outer edge can no longer be told from
       the inner. Tighten the centre first: a least-squares circle through the
       points near the candidate, then measure everything from there. */
    let c = c0;
    for (let pass = 0; pass < 2; pass++) {
      const ring = pts.filter((p) => Math.abs(Math.hypot(p.x - c.cx, p.y - c.cy) - c.r) <= c.r * 0.12);
      const circ = fitEllipse(ring);
      if (circ && circ.ratio > 0.7) c = { ...c, cx: circ.cx, cy: circ.cy, r: (circ.major + circ.minor) / 2 };
    }
    /* A tyre is a ring, so around the candidate there are TWO circles of
       edge points: the tyre against the wall and the tyre against the rim.
       Fitting one ellipse through both gives a blur of the two that reads as
       rounder than either. Histogram the radii of everything nearby, and take
       the OUTERMOST strong ring — that is the tyre's outside edge, and it is
       the 670 mm the calibration is about. */
    const wide = pts.filter((p) => Math.abs(Math.hypot(p.x - c.cx, p.y - c.cy) - c.r) <= c.r * 0.3);
    const bin = 1.5, lo = c.r * 0.7;
    const hist = new Uint16Array(Math.ceil((c.r * 0.6) / bin) + 1);
    for (const p of wide) {
      const k = Math.floor((Math.hypot(p.x - c.cx, p.y - c.cy) - lo) / bin);
      if (k >= 0 && k < hist.length) hist[k]++;
    }
    const peak = Math.max(...hist);
    let outer = -1;
    for (let k = hist.length - 1; k >= 0; k--) if (hist[k] >= peak * 0.5) { outer = k; break; }
    if (outer < 0) continue;
    const rOuter = lo + (outer + 0.5) * bin;
    /* Seen off-square the ring is an ellipse, so from the Hough centre its
       radius runs from the minor axis up to the major. Start from a band that
       reaches inward far enough to hold the whole ring at a plausible yaw but
       not the tyre's inner edge, which sits about 8% further in. */
    let near = wide.filter((p) => {
      const rr = Math.hypot(p.x - c.cx, p.y - c.cy);
      return rr >= rOuter * 0.93 && rr <= rOuter + 2.5;
    });
    let ell = fitEllipse(near);
    if (!ell) continue;
    /* A circular band around an ellipse keeps only the points near its long
       axis, so the first fit comes out rounder than the wheel. Re-select the
       points by their distance to THAT ellipse and fit again; three passes
       settle it. */
    for (const tol of [0.06, 0.045, 0.035]) {
      const ca = Math.cos(ell.angle), sa = Math.sin(ell.angle);
      const onIt = wide.filter((p) => {
        const dx = p.x - ell.cx, dy = p.y - ell.cy;
        const u = (dx * ca + dy * sa) / ell.major, v = (-dx * sa + dy * ca) / ell.minor;
        return Math.abs(Math.hypot(u, v) - 1) < tol;
      });
      const next = fitEllipse(onIt);
      if (!next) break;
      near = onIt; ell = next;
    }
    // A wheel is close to round; a fit that is not was a curve of something else.
    if (ell.ratio < 0.55 || ell.major > rOuter * 1.25 || ell.major < rOuter * 0.8) continue;
    // Support: how much of the circumference actually has an edge on it.
    const bins = new Uint8Array(36);
    for (const p of near) bins[Math.floor(((Math.atan2(p.y - ell.cy, p.x - ell.cx) + Math.PI) / (2 * Math.PI)) * 36) % 36] = 1;
    const coverage = bins.reduce((s, b) => s + b, 0) / 36;
    if (coverage < 0.45) continue;                     // half a wheel hidden is still a wheel
    return { ...ell, r: (ell.major + ell.minor) / 2, coverage, support: near.length, score: c.score };
  }
  return null;
}

/* Several frames of a bike that is not moving, made into one answer. Median
   per parameter, so one frame where the rider's leg crossed the rim does not
   set the wheel's size. */
export function settleWheel(wheels) {
  const w = wheels.filter(Boolean);
  if (w.length < 2) return w[0] ?? null;
  const med = (k) => { const a = w.map((x) => x[k]).sort((p, q) => p - q); return a[a.length >> 1]; };
  return { cx: med("cx"), cy: med("cy"), major: med("major"), minor: med("minor"), r: med("r"),
           ratio: med("ratio"), angle: med("angle"), coverage: med("coverage"), frames: w.length };
}

/* What a wheel tells us. Road wheel with tyre ≈ 670 mm; the major axis is the
   true diameter whatever the yaw, because a circle's longest chord survives
   projection. Yaw from the axis ratio: cos(yaw) = minor / major. */
export const WHEEL_MM = 670;
export function calibrate(wheel) {
  if (!wheel) return null;
  const mmPerPx = WHEEL_MM / (2 * wheel.major);
  /* Coarse by nature: cos is flat near zero, so one pixel on the short axis is
     about five degrees of yaw. It says whether the camera is off and roughly
     how far; it is not precise enough to correct angles with on its own. */
  const yawDeg = Math.acos(Math.min(1, Math.max(0, wheel.ratio))) * 180 / Math.PI;
  return { mmPerPx, yawDeg: +yawDeg.toFixed(0), diameterPx: 2 * wheel.major, ratio: +wheel.ratio.toFixed(3) };
}
