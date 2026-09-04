import { BANDS, CAPTURE, ANGLE_FLOOR_DEG, VERDICT_SIGMAS, SETTLE_RIDES, POSE_MODEL, REFINE_STROKES, FINE_MODEL_TIMEOUT_MS, SUBFRAME, SANITY, FINE_OFFSET,
         FEMUR_OVER_HEIGHT, AXLE_ALONG_FOOT } from "./config.js";
import { boneLengths, bestLeg, movedTooFar } from "./limbs.js";
import { crankAngles, harmonic, cadenceFrom, framesAt, BDC, TDC, THREE } from "./cycle.js";
import { findWheel, settleWheel, calibrate, WHEEL_MM } from "./wheel.js";

/* On-device side-view analysis.
   MediaPipe Pose Landmarker (WASM) runs in the browser; the video never
   leaves the phone. Port of the validated Python pipeline:
   sample frames → landmarks → ankle-y cycle detection → per-stroke averages. */

const MP_WASM = new URL("../assets/mp/", import.meta.url).href;
let filesetPromise = null;
const fileset = () => (filesetPromise ??= (async () => {
  const { FilesetResolver } = await import("./vendor/tasks-vision.js");
  return FilesetResolver.forVisionTasks(MP_WASM);
})());

/* The GPU delegate is a large speed-up where it exists and simply absent on
   some phones and lockdown-mode browsers, so it is attempted and then dropped
   rather than assumed. A slower analysis is a far better outcome than one that
   cannot start. */
async function makeLandmarker(model, runningMode) {
  const { PoseLandmarker } = await import("./vendor/tasks-vision.js");
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: POSE_MODEL.url(model), delegate },
    runningMode, numPoses: 1,
  });
  const fs = await fileset();
  try { return await PoseLandmarker.createFromOptions(fs, opts("GPU")); }
  catch { return PoseLandmarker.createFromOptions(fs, opts("CPU")); }
}

const cache = new Map();
const landmarker = (model, mode) => {
  const key = `${model}:${mode}`;
  if (!cache.has(key)) {
    /* Drop a failed load from the cache. A rejected promise left in here was
       permanent: one bad download and every analysis for the rest of the
       session skipped the accurate model instantly, with no second attempt. */
    const p = makeLandmarker(model, mode).catch((e) => { cache.delete(key); throw e; });
    cache.set(key, p);
  }
  return cache.get(key);
};

// The sweep model: small and quick, run over every sampled frame.
const getLandmarker = () => landmarker(POSE_MODEL.sweep, "VIDEO");
/* The fine model: slower and more accurate, run only on the frames a reported
   number is computed from. Loaded lazily so a rider whose clip gates out never
   pays for the download. */
const getFineLandmarker = () => landmarker(POSE_MODEL.fine, "IMAGE");

const deg = (r) => (r * 180) / Math.PI;

/* MediaPipe normalises x by frame WIDTH and y by frame HEIGHT, so on any
   non-square clip the two axes are in different units and every angle taken
   straight from them is wrong — by 10-16 degrees on a 16:9 phone video, which
   is wider than the bands themselves. Put x back into y's units first. */
export const squareUp = (ar) => (p) => ({ x: p.x * ar, y: p.y });

export function angleAt(a, b, c) {
  const v1 = [a.x - b.x, a.y - b.y], v2 = [c.x - b.x, c.y - b.y];
  const dot = v1[0] * v2[0] + v1[1] * v2[1];
  const n = Math.hypot(...v1) * Math.hypot(...v2) + 1e-9;
  return deg(Math.acos(Math.max(-1, Math.min(1, dot / n))));
}
/* THE SAME ANGLE, MEASURED WHERE THE CAMERA CANNOT REACH IT.

   An angle read off the picture is an angle between two lines that have been
   flattened onto the phone's sensor, so it carries the phone with it: hold the
   camera a foot higher, a metre further back, ten degrees off square, or swap
   the wide lens for the ultrawide, and the same leg in the same position reads
   differently. Asking riders to place a phone identically every time is asking
   for something nobody does — the phone slips, the ground is not level, the
   front camera gets used because it is easier to see the screen.

   The pose model already solves this and we were throwing it away. Alongside
   the flattened landmarks it returns worldLandmarks: the same joints in metres
   in three dimensions, centred on the hips, reconstructed rather than
   projected. The angle between three of those is the angle the joint actually
   made. It does not know where the phone was, so it cannot be moved by it.

   The picture is still drawn from the flat landmarks — that is what is
   underneath the rider in the video — so on a badly-placed phone the drawn
   limb and the reported number can differ. That gap is not an error; it is the
   size of the camera's lie, and the still says so rather than hiding it. */
export function angleAt3D(a, b, c) {
  if (!a || !b || !c) return null;
  const v1 = [a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0)];
  const v2 = [c.x - b.x, c.y - b.y, (c.z ?? 0) - (b.z ?? 0)];
  const dot = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
  const n = Math.hypot(...v1) * Math.hypot(...v2) + 1e-9;
  return deg(Math.acos(Math.max(-1, Math.min(1, dot / n))));
}

/* A world reading is only used when it is actually there and actually sane:
   a leg bent past what a leg does means the depth axis lost the joint, and
   the flat reading — camera and all — is the better of two bad answers. */
function kneeFromWorld(w, side) {
  if (!w) return null;
  const j = SIDES[side](w);
  const v = angleAt3D(j.hip, j.knee, j.ankle);
  if (v == null) return null;
  const bend = 180 - v;
  return bend >= 0 && bend <= 160 ? bend : null;
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };

function findPeaks(sig, minDist, prominence) {
  const peaks = [];
  for (let i = 1; i < sig.length - 1; i++) {
    if (sig[i] >= sig[i - 1] && sig[i] > sig[i + 1]) {
      if (peaks.length && i - peaks.at(-1) < minDist) {
        if (sig[i] > sig[peaks.at(-1)]) peaks[peaks.length - 1] = i;
      } else peaks.push(i);
    }
  }
  const lo = Math.min(...sig), hi = Math.max(...sig);
  return peaks.filter((p) => sig[p] - lo > prominence * (hi - lo));
}

// Palette shared with the FORM report shell. Verdict colour is only ever used
// on the rider's own limb — never on a reference.
const IN_BAND = "#34D27B", OUT_OF_BAND = "#F2C230";

// The camera sees one side of the rider; take whichever is more visible.
const SIDES = {
  L: (p) => ({ hip: p[23], knee: p[25], ankle: p[27], sho: p[11], heel: p[29], toe: p[31] }),
  R: (p) => ({ hip: p[24], knee: p[26], ankle: p[28], sho: p[12], heel: p[30], toe: p[32] }),
};
const sideVis = (j) => mean([j.hip, j.knee, j.ankle].map((q) => q.visibility ?? 1));

/* One leg, chosen by which one this camera saw better across the WHOLE clip.
   `flipped` is how many frames would have gone the other way — a high count
   means the phone was not truly side-on and the two legs look alike. */
/* Take at most `budget` items, evenly spaced across the run rather than the
   first N — strokes early in a clip are the least settled ones. */
export function spread(idxs, budget) {
  if (budget < 1) return [];
  if (idxs.length <= budget) return idxs;
  if (budget === 1) return [idxs[idxs.length >> 1]];
  return Array.from({ length: budget },
    (_, i) => idxs[Math.round((i * (idxs.length - 1)) / (budget - 1))]);
}

/* SADDLE FORE/AFT — the gap every review of these apps points at.
   At the three o'clock crank position, fitters look at where the front of the
   knee sits relative to the pedal axle. Finding that moment needs no crank:
   the ankle is furthest forward exactly when the crank is horizontal and
   forward. The axle itself is invisible to the model, so it is placed along
   the foot at AXLE_ALONG_FOOT. Both of those are assumptions, which is why
   this reports a position and never a verdict.

   Returns the offset in thigh-lengths, which needs no assumption about the
   rider at all; centimetres are added later only if their height is known. */
/* The frames where the crank is horizontal and forward: the ankle is furthest
   forward exactly then. Split out from the measurement so those frames can be
   re-read with the accurate model before the measurement is taken — otherwise
   the fore/aft card would be the one number in the report still coming from
   the sweep. */
export function threeOClock(rows, fps) {
  const lean = median(rows.map((r) => r.x.sho - r.x.hip));
  if (!Number.isFinite(lean) || Math.abs(lean) < 1e-3) return { forward: 0, three: [] };
  const forward = Math.sign(lean);
  const reach = rows.map((r) => forward * r.x.ankle);
  const three = findPeaks(reach, fps * 0.45, 0.25)
    .filter((i) => rows[i].conf >= CAPTURE.minJointVisibility);
  return { forward, three };
}

/* WHERE THE PEDAL SPINDLE ACTUALLY IS, measured rather than assumed.
 *
 * Everything else in this app is read off the rider. The axle was the one
 * exception: a constant saying it sits 28% of the way from the toe landmark
 * back towards the heel, because "cleats are normally set under the ball of the
 * foot". That is a population average standing in for a measurement, and the
 * fore/aft number is built entirely on it.
 *
 * It does not need to be. Through a pedal stroke the foot both revolves around
 * the bottom bracket AND rocks about the spindle, so every point on the foot
 * traces a circle plus a wobble — except the spindle itself, which traces the
 * cleanest circle there is. Walk a candidate point along the toe-to-heel line,
 * fit a circle to the path each one traces, and the spindle is the one that
 * fits best.
 *
 * The fitted circle then gives something else for free. Its radius is the crank
 * length, and cranks are 170 mm on almost every bike ever sold. So the ratio
 * "knee offset ÷ crank radius" turns into centimetres with no rider height, no
 * population thigh proportion, and — because both are measured in the same
 * frame — no dependence on scale or on how square the camera was. */
function fitCircle(pts) {
  const n = pts.length;
  if (n < 12) return null;
  let Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0, Sz = 0, Sxz = 0, Syz = 0;
  for (const { x, y } of pts) {
    const z = x * x + y * y;
    Sx += x; Sy += y; Sxx += x * x; Syy += y * y; Sxy += x * y;
    Sz += z; Sxz += x * z; Syz += y * z;
  }
  // Kåsa: least squares on x² + y² = 2ax + 2by + c, with c = r² − a² − b².
  const M = [[2 * Sxx, 2 * Sxy, Sx], [2 * Sxy, 2 * Syy, Sy], [2 * Sx, 2 * Sy, n]];
  const v = [Sxz, Syz, Sz];
  const det = M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1])
            - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0])
            + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-14) return null;
  const solve = (col) => {
    const A = M.map((row, i) => row.map((q, j) => (j === col ? v[i] : q)));
    return (A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1])
          - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0])
          + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0])) / det;
  };
  const cx = solve(0), cy = solve(1), c = solve(2);
  const rr = c + cx * cx + cy * cy;
  if (!(rr > 0)) return null;
  const r = Math.sqrt(rr);
  /* A path has to have gone somewhere. A foot that barely moved fits a circle
     of any radius you like with no error at all, which is a perfect score for
     having measured nothing — so require the points to cover a real arc: a
     whole revolution spans about 2.8 radii corner to corner, and anything
     under about half a radius never went round. */
  const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
  const spread = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (!(spread > 1.2 * r)) return null;
  // How far off a circle the path actually is, as a share of its own radius.
  const off = pts.map(({ x, y }) => Math.abs(Math.hypot(x - cx, y - cy) - r));
  return { cx, cy, r, residual: median(off) / r, n };
}

export function pedalAxle(rows, diag = {}) {
  const usable = rows.filter((r) => r.fy && Number.isFinite(r.fy.toe) && Number.isFinite(r.fy.heel)
    && r.conf >= CAPTURE.minJointVisibility);
  diag.footFrames = usable.length;
  if (usable.length < 40) return null;

  let best = null;
  for (let u = 0; u <= 0.7001; u += 0.02) {
    const pts = usable.map((r) => ({
      x: r.x.toe + u * (r.x.heel - r.x.toe),
      y: r.fy.toe + u * (r.fy.heel - r.fy.toe),
    }));
    const fit = fitCircle(pts);
    if (fit && (!best || fit.residual < best.residual)) best = { ...fit, along: +u.toFixed(2) };
  }
  /* A foot that never traced a circle worth the name — the rider stopped
     pedalling, or the model lost the foot. Better to fall back to the
     population figure than to build centimetres on a bad fit. */
  /* What the best circle looked like, whether or not it was good enough —
     so a ride whose curve fell back to one-frame reads says how close it came. */
  if (best) { diag.residual = +best.residual.toFixed(3); diag.along = best.along; diag.crank = +best.r.toFixed(4); }
  if (!best || best.residual > 0.12) return null;
  return best;
}

/* WHY THIS NUMBER IS RIGHT — OR NOT — FOR THIS RIDER, NOW.
   A card that says "33°, in range" has told the rider a fact and left them to
   trust it. The rule from the rider who uses this app: every measurement card
   carries something tangible, and a perfect setup is still explained — WHY we
   think it is perfect right now, in terms of what the body is doing at that
   exact value. So each card's working opens with a sentence written for the
   number that was actually measured: where in the range it sits, what that end
   of the range means for the muscles doing the work, and what would change if
   it moved. */
export function whyNow(card, v, band) {
  const d = Math.round(v);
  const [lo, hi] = band ?? [NaN, NaN];
  const third = (lo + hi) / 3;
  switch (card) {
    case "knee":
      if (v < lo) return `At ${d}° your leg is straightening further than riders go. Each push ends with the knee close to locked, so the hip drops to reach the pedal and the hamstring takes strain the quad should have finished.`;
      if (v > hi) return `At ${d}° your knee is still well bent at the bottom, so you never get through the strongest part of the push and the front of the knee carries more of every stroke than it needs to.`;
      if (v < lo + (hi - lo) / 3) return `At ${d}° your leg is nearly straight at the bottom without locking out. That favours the glutes and hamstrings at the end of each push and leaves the knee a little slack to absorb the pedal coming round. It is the straighter end of right — if the back of your knee ever starts complaining, 2–3 mm down is the first thing to try.`;
      if (v > hi - (hi - lo) / 3) return `At ${d}° your knee keeps a little more bend at the bottom than most riders. That loads the quads and the front of the knee a touch more and gives the hips nothing to reach for. If you ever want more leverage on a big gear, there is room to go up 2–3 mm.`;
      return `At ${d}° your leg finishes the push with the big muscles above the knee, keeps enough bend to absorb the bottom of the stroke, and leaves your hips level. That is the middle of where riders sit, and nothing here would improve for a millimetre either way.`;
    case "toe":
      if (v > hi) return `At ${d}° toe-down you are reaching for the pedal with your toes. The calf is finishing every push, and it is a small muscle that tires long before the ones above the knee. It can also be the first sign of a saddle a touch high, so read it beside the knee angle above.`;
      if (v < lo) return `At ${d}° your heel is dropping below level at the bottom. The ankle has already given everything it can, so the leg has to reach with the hip instead.`;
      if (v < (lo + hi) / 2) return `At ${d}° toe-down your heel drops through the bottom of the stroke, which lets the calf relax and hands the last of the push to the muscles above the knee. That is the flatter end of right, and it is where the leg is most efficient.`;
      return `At ${d}° toe-down your foot points down a little at the bottom — inside where riders sit, using the calf to finish the stroke without leaning on it. Fine as it is; it is worth a glance only if it creeps higher.`;
    case "hip":
      if (v < lo) return `At ${d}° your thigh meets your torso before the pedal reaches the top, so the stroke stalls there and has to restart on the way down. That is the catch riders feel, and it costs power exactly where the next push should begin.`;
      if (v > hi) return `At ${d}° your hip has plenty of room at the top of the stroke — your thigh never gets near your torso, so the leg comes over the top freely and your breathing has all the space it wants. Comfortable, and it leaves room to get lower on the bars if speed on the flat matters to you.`;
      if (v < (lo + hi) / 2) return `At ${d}° your hip closes fairly tight at the top of each stroke — inside what fitters work to, at the folded end. It suits a low, fast position and a back that bends well. If the top of the stroke ever feels like a catch, saddle setback or a spacer under the bars is what opens it.`;
      return `At ${d}° there is comfortable room between thigh and torso at the top of each stroke. The pedal reaches the top before the hip runs out of room, so the stroke carries straight through instead of stalling, and your breathing has space to work.`;
    case "cadence":
      if (v < lo) return `At ${d} rpm each stroke asks more of the leg itself, so the muscles carry the effort and tire before your breathing does. You will feel it most in the last hour.`;
      if (v > hi) return `At ${d} rpm your heart and lungs are carrying most of the effort and staying there — fine until the breathing is what limits you, on a climb or at the end of a hard hour.`;
      return `At ${d} rpm the effort is shared: your legs turn light enough not to burn out early, and your breathing is not yet the limit. That balance is what lets the last hour feel like the first.`;
    case "torso":
      if (v < 20) return `At ${d}° above horizontal you are riding very low. That saves the most air at speed, and it asks the most of your hip flexors and lower back to hold — a position worth having if you can stay in it.`;
      if (v < 30) return `At ${d}° above horizontal your back is in a moderate road position: low enough to save you real effort at speed, high enough that your lungs have room and your hip flexors can hold it for hours. Most of the gain from getting lower has already been taken here.`;
      if (v < 45) return `At ${d}° your back is fairly upright — easy for your hips and lower back to hold, easy to breathe in, at the cost of more air to push through at speed. Comfortable for long days; there is position to find if the flat gets faster.`;
      return `At ${d}° your back is nearly upright and your arms are carrying very little. It is the easiest position there is to hold, and there is a lot of speed sitting unused between here and the bars — your hips and lower back would need to get used to it gradually.`;
    default: return "";
  }
}

/* The same, for the knee over the pedal, which has no range to be in. */
export function whyForeAft(ofFemur, cm) {
  const near = Math.abs(ofFemur) < 0.07;
  const where = cm != null ? `${Math.abs(cm).toFixed(1)} cm ${cm > 0 ? "ahead of" : "behind"}` : (ofFemur > 0 ? "ahead of" : "behind");
  if (near) return `Your knee sits ${cm != null ? `within ${Math.abs(cm).toFixed(1)} cm of` : "stacked over"} the pedal axle with the cranks level — the reference point fitters start from. The work splits evenly between quads and glutes, and your hands carry no more of your weight than they need to.`;
  if (ofFemur > 0) return `Your knee sits ${where} the pedal axle with the cranks level. That leans the work onto the quads and the front of the knee and puts a little more of your weight on the bars — the punchy, forward position some riders choose on purpose, and one worth knowing you are in.`;
  return `Your knee sits ${where} the pedal axle with the cranks level. That brings the glutes and hamstrings into each push and takes weight off your hands — the position many endurance riders settle into, and one worth knowing you are in.`;
}

/* And for the two views with no range to be in: said for the number measured,
   in terms of what the body is doing, so a level pelvis is explained rather
   than merely reported. */
export function whyFront(left, right) {
  const both = left != null && right != null;
  const big = Math.max(left ?? 0, right ?? 0);
  const l = left != null ? `${left.toFixed(0)}°` : null, r = right != null ? `${right.toFixed(0)}°` : null;
  const pair = both ? `${l} on the left and ${r} on the right` : `${l ?? r} on the one knee we could see`;
  if (big < 8) return `Your knees track close to straight — ${pair} over a stroke — so each push goes down into the pedal rather than out to the side, and the joint is loaded the way it is built to be. This is the pattern riders with no knee trouble tend to show.`;
  if (big < 15) return `Your knees swing ${pair} over a stroke — more than the straightest riders, enough that a share of each push is going sideways. Not a problem on its own; it becomes worth acting on if either knee aches on the inside or the outside, and cleat angle is the first thing to look at.`;
  return `Your knees swing ${pair} over a stroke, which is a lot. That much sideways movement usually traces back to the feet — cleat angle, or a foot that wants support it is not getting — and it is the most common thing sitting behind an ache on the inside of the knee.`;
}

export function whyRock(pelvis, shoulder) {
  const p = pelvis != null ? pelvis : null;
  if (p == null && shoulder != null)
    return `Your shoulder line tips ${shoulder.toFixed(0)}° over a stroke. On its own that is mostly how you ride; it matters when the hips underneath are moving too, and we could not read them cleanly this time.`;
  if (p < 3) return `Your hips tilt ${p.toFixed(0)}° over a stroke — effectively level. You are not reaching for the pedals at the bottom, which backs up the saddle height read from the side: the leg is getting to the pedal without the pelvis having to help.`;
  if (p < 6) return `Your hips tilt ${p.toFixed(0)}° over a stroke — a little rock, and most riders show some. Beside a knee angle at the straighter end it would point at a saddle a touch high; beside a knee angle in the middle it is simply how you ride.`;
  return `Your hips tilt ${p.toFixed(0)}° over a stroke, which is real rocking: your pelvis is dropping to reach the bottom of each stroke. That is the body coping with a saddle that is slightly too high, and it is what starts rubbing two hours into a long ride.`;
}

/* THE NUGGET. A rider whose setup is right still opens the report to
   something worth reading — not a list of things that were fine, but the one
   thing about THEIR riding that is most distinctive: whichever measurement sits
   furthest from the middle of its range, said as what it means and what to
   keep an eye on. It is chosen by distance from the middle in units of each
   range's own width, so a foot at the top edge outranks a knee dead centre. */
export function nugget({ knee, toe, hip, cadence }) {
  const [kLo, kHi] = BANDS.kneeBendBDC, [tLo, tHi] = BANDS.footToeDown6, [hLo, hHi] = BANDS.hipTDC, [cLo, cHi] = BANDS.cadence;
  const edge = (v, lo, hi) => (v == null ? 0 : (v - (lo + hi) / 2) / ((hi - lo) / 2));
  const c = [
    { k: "knee", e: edge(knee, kLo, kHi) },
    { k: "toe", e: edge(toe, tLo, tHi) },
    { k: "hip", e: edge(hip, hLo, hHi) },
    { k: "cadence", e: edge(cadence, cLo, cHi) },
  ].filter((x) => Number.isFinite(x.e)).sort((a, b) => Math.abs(b.e) - Math.abs(a.e));
  const top = c[0];
  if (!top || Math.abs(top.e) < 0.4)
    return `Everything we measured sits near the middle of its range — knee ${Math.round(knee)}° at the bottom, ${Math.round(cadence)} rpm — which is rarer than it sounds. Most riders have one number leaning on an edge; you do not have one to watch.`;
  const d = (v) => Math.round(v);
  switch (top.k) {
    case "knee": return top.e < 0
      ? `The one to keep an eye on is your knee: ${d(knee)}° at the bottom is the straighter end of right. It favours the glutes and it works — if the back of the knee ever starts complaining on long rides, that is why, and 2–3 mm down is the answer.`
      : `The one to keep an eye on is your knee: ${d(knee)}° at the bottom keeps more bend than most riders. It loads the quads a touch more and it works — if you ever want more leverage on a big gear, there is room to raise the saddle 2–3 mm.`;
    case "toe": return top.e > 0
      ? `The one to keep an eye on is your foot: ${d(toe)}° toe-down at the bottom is right up at the top of where riders go. It works now; if your calves are the first thing to tire on a long climb, this is why, and thinking about dropping the heel through the bottom is the fix.`
      : `The one to keep an eye on is your foot: at ${d(toe)}° toe-down your heel drops further through the bottom than most. It hands the work to the big muscles above the knee, which is efficient — just make sure the ankle is not being asked to give more than it has.`;
    case "hip": return top.e < 0
      ? `The one to keep an eye on is the top of your stroke: at ${d(hip)}° your hip closes tighter than most riders' at the top. It suits a low, fast position — if the top of the stroke ever feels like a catch, saddle setback or a spacer under the bars opens it.`
      : `The one to keep an eye on is the top of your stroke: at ${d(hip)}° your hip stays more open than most, which is comfortable and easy to breathe in. If speed on the flat matters to you, there is room to get lower on the bars before the hip runs out of space.`;
    default: return top.e < 0
      ? `The one to keep an eye on is your cadence: ${d(cadence)} rpm is the grinding end of right. Your legs carry more of each stroke than your breathing does — fine for short efforts, and worth a gear lower when the ride gets long.`
      : `The one to keep an eye on is your cadence: ${d(cadence)} rpm is the spinning end of right. Your heart and lungs carry more of the effort than your legs — light on the muscles, and worth a gear higher if your breathing is what gives out first on climbs.`;
  }
}

/* THE WHOLE STROKE AT ONCE.
   Every number the side view reports is taken at a moment of the pedal
   circle: the knee and the foot at the bottom, the hip at the top, the knee
   over the axle with the cranks level. The old way found a frame near each
   moment and read it — one noisy sample per stroke, chosen by the noise.
   This fits each quantity as a smooth periodic curve of crank angle over every
   frame in the clip and reads the curve at the exact moment. Thirty simulated
   rides: one frame per stroke lands 1.7° from the truth on average, the curve
   0.7°. It is computed from the sweep alone, before any frame is re-read by
   the other model, so one median never mixes two models. */
/* The systematic gap between the two pose models on this clip: the accurate
   model's reading minus the sweep's, on the very same frames, as a median over
   the strokes both have read. A handful of strokes is not evidence of a bias,
   and a gap of many degrees is a frame one of them misread rather than a
   calibration difference, so both cases return nothing and the curve stands
   uncorrected. */
export function modelOffset(rows, idxs, key) {
  const d = idxs.map((i) => rows[i]?.sweep).filter((s) => s?.fine)
    .map((s) => s.fine[key] - s[key]).filter(Number.isFinite);
  if (d.length < FINE_OFFSET.minStrokes) return null;
  const m = median(d);
  if (!(Math.abs(m) <= FINE_OFFSET.maxDeg)) return null;
  return { value: +m.toFixed(2), sd: +sd(d).toFixed(2), n: d.length };
}

export function strokeCurve(rows, fps, diag = {}) {
  const spindle = pedalAxle(rows, diag);
  if (!spindle) { diag.why = "no pedal circle"; return null; }
  const usable = (r) => r.fy && Number.isFinite(r.fy.toe) && r.conf >= CAPTURE.minJointVisibility;
  const pts = rows.map((r) => usable(r)
    ? { x: r.x.toe + spindle.along * (r.x.heel - r.x.toe), y: r.fy.toe + spindle.along * (r.fy.heel - r.fy.toe) }
    : null);
  const theta = crankAngles(pts, spindle);
  const cad = cadenceFrom(theta, rows.map((r) => r.t));
  if (!cad || cad.revolutions < 4) { diag.why = cad ? `only ${cad.revolutions.toFixed(1)} revolutions` : "no cadence"; return null; }
  const { forward } = threeOClock(rows, fps);

  const fitOf = (get) => harmonic(theta, rows.map((r) => (usable(r) ? get(r) : NaN)), 3);
  const fits = {
    knee: fitOf((r) => r.kneeBend), flat: fitOf((r) => r.kneeFlat),
    toe: fitOf((r) => r.toeDown), hip: fitOf((r) => r.hip), torso: fitOf((r) => r.torso),
    kneeX: fitOf((r) => r.x.knee), toeX: fitOf((r) => r.x.toe), heelX: fitOf((r) => r.x.heel),
  };
  if (!fits.knee) { diag.why = "knee curve did not fit"; return null; }
  const revs = Math.max(1, Math.round(cad.revolutions));
  const read = (fit, at) => (fit ? { value: fit.at(at), sd: fit.sdNear(at), n: revs, of: revs, curve: true } : null);

  const three = THREE(forward);
  let foreaft = null;
  if (forward && fits.kneeX && fits.toeX && fits.heelX) {
    const axleX = fits.toeX.at(three) + spindle.along * (fits.heelX.at(three) - fits.toeX.at(three));
    const mid = forward * (fits.kneeX.at(three) - axleX);
    const femur = median(rows.filter(usable).map((r) => r.femur));
    const frames = framesAt(theta, three);
    const offAt = (i) => {
      const j = rows[i].x, axle = j.toe + spindle.along * (j.heel - j.toe);
      return forward * (j.knee - axle);
    };
    const cm = (mid / spindle.r) * 17.25;
    if (femur > 1e-3 && Math.abs(mid / femur) <= 0.35)
      foreaft = {
        ofFemur: mid / femur, sd: fits.kneeX.sdNear(three) / femur, n: revs, curve: true,
        fromCrank: Math.abs(cm) < 12 ? +cm.toFixed(1) : null,
        sdCrankCm: +((fits.kneeX.sdNear(three) / spindle.r) * 17.25).toFixed(1),
        spindle: { along: spindle.along, crank: +spindle.r.toFixed(4), fit: +spindle.residual.toFixed(3) },
        ranked: frames.map((idx) => ({ idx, d: Math.abs(offAt(idx) - mid) })).sort((a, b) => a.d - b.d).map((x) => x.idx),
        at: frames.length ? frames.reduce((b, i) => (Math.abs(offAt(i) - mid) < Math.abs(offAt(b) - mid) ? i : b), frames[0]) : null,
      };
  }

  return {
    spindle, forward, cadence: cad.rpm, revolutions: +cad.revolutions.toFixed(1),
    kneeBDC: read(fits.knee, BDC), kneeFlatBDC: read(fits.flat, BDC),
    toeBDC: read(fits.toe, BDC), hipTDC: read(fits.hip, TDC),
    foreaft,
    bdcFrames: framesAt(theta, BDC), tdcFrames: framesAt(theta, TDC),
    // how well each curve explains the frames — the model's per-frame noise
    fit: { knee: +fits.knee.sd.toFixed(2), toe: fits.toe ? +fits.toe.sd.toFixed(2) : null, hip: fits.hip ? +fits.hip.sd.toFixed(2) : null },
  };
}

export function kneeOverAxle(rows, fps) {
    const { forward, three } = threeOClock(rows, fps);
    if (!forward || three.length < 3) return null;

    /* The spindle, measured from the path the foot traced; the population
       figure only where the clip could not give one. */
    const spindle = pedalAxle(rows);
    const along = spindle ? spindle.along : AXLE_ALONG_FOOT;

    const offs = three.map((i) => {
      const j = rows[i].x;
      const axle = j.toe + along * (j.heel - j.toe);
      return forward * (j.knee - axle);        // + = knee ahead of the axle
    });
    const femur = median(three.map((i) => rows[i].femur));
    if (!(femur > 1e-3)) return null;
    const mid = median(offs);
    /* Centimetres from the crank, when we measured one. The circle the foot
       traced IS the crank, so offset ÷ radius × 172.5 mm is a real distance —
       no rider height, no population thigh, and no dependence on scale or on
       how square the camera was, because both numbers come off the same frame. */
    const cm = spindle ? (mid / spindle.r) * 17.25 : null;
    const sdCm = spindle ? (sd(offs) / spindle.r) * 17.25 : null;
    /* No rider sits this far off. Past a third of a thigh it is the model
       having put the toe or the heel somewhere that is not the foot, and a
       number built on that should not reach a card at all. */
    if (Math.abs(mid / femur) > 0.35) return null;
    return {
      // in thigh-lengths, which needs no assumption about the rider at all
      ofFemur: mid / femur,
      fromCrank: cm != null && Math.abs(cm) < 12 ? +cm.toFixed(1) : null,
      sdCrankCm: sdCm != null ? +sdCm.toFixed(1) : null,
      spindle: spindle
        ? { along: spindle.along, crank: +spindle.r.toFixed(4), fit: +spindle.residual.toFixed(3) }
        : null,
      sd: sd(offs) / femur,
      n: offs.length,
      /* Strokes ranked by how close each is to the reported figure, so the
         still shows the stroke the number describes — and so a frame the model
         read badly is not the end of it. */
      ranked: three.map((idx, i) => ({ idx, d: Math.abs(offs[i] - mid) }))
        .sort((a, b) => a.d - b.d).map((x) => x.idx),
      at: three[offs.reduce((b, v, i) => (Math.abs(v - mid) < Math.abs(offs[b] - mid) ? i : b), 0)],
    };
  }

export function dominantSide(frames) {
  /* WHICH LEG IS NEARER THE CAMERA — not which one the model felt surest about.
     Visibility was the wrong signal. The model reports a confident-looking
     score for a leg it is inferring behind the frame, so on a side view the two
     scores come out close, and the tie-break then decided it: `>=` favoured L,
     and so did the `lWins * 2 >= frames.length` comparison. A near-tie always
     went the same way regardless of which leg the camera could actually see —
     and the report drew, and measured, the hidden one.

     The landmarks carry depth: z is distance from the camera with the hips as
     the origin, so the nearer leg simply has the smaller z. That is a physical
     answer rather than a proxy for one. Where the two legs sit at genuinely
     the same depth — filmed from the front, or a clip too poor to separate
     them — it falls back to visibility, which is the best that is left. */
  const depth = (key) => {
    const zs = frames
      .map((f) => mean([f[key].hip, f[key].knee, f[key].ankle].map((q) => q.z ?? NaN)))
      .filter(Number.isFinite);
    return zs.length >= 5 ? median(zs) : null;
  };
  const zL = depth("L"), zR = depth("R");
  const seen = (key) => mean(frames.map((f) => sideVis(f[key])));

  const bySight = seen("L") >= seen("R") ? "L" : "R";
  /* A hip's width in these units is around a tenth of the frame, so legs a
     fiftieth apart are genuinely one in front of the other rather than noise. */
  const separated = zL != null && zR != null && Math.abs(zL - zR) > 0.02;
  const side = separated ? (zL < zR ? "L" : "R") : bySight;

  /* How many frames would have gone the other way, on whichever signal
     decided — a high count means the two legs were never really told apart. */
  const otherWay = frames.filter((f) => separated
    ? (mean([f.L.hip, f.L.knee, f.L.ankle].map((q) => q.z ?? 0))
        < mean([f.R.hip, f.R.knee, f.R.ankle].map((q) => q.z ?? 0))) !== (side === "L")
    : (sideVis(f.L) >= sideVis(f.R)) !== (side === "L")).length;
  return { side, flipped: otherWay, by: separated ? "depth" : "visibility" };
}

/* Which leg to measure. THIS MUST BE DECIDED ONCE FOR THE WHOLE CLIP, not per
   frame. A rider's legs are 180 degrees out of phase, so a per-frame choice —
   which is what shipped — swaps to the far leg the moment it is momentarily
   the better-seen one, and then the "knee angle at the bottom of the stroke"
   is being read off a leg that is at the top of it. That is visible as the
   overlay snapping between legs, and invisible as inflated spread and a
   centre pulled towards the middle of the two. */
export function pickSide(p, side) {
  const at = side ?? (sideVis(SIDES.L(p)) >= sideVis(SIDES.R(p)) ? "L" : "R");
  return SIDES[at](p);
}

// Every joint in `pts` must be visible in THIS frame — the caller checks that
// before asking for a line. Solid = the rider's own body (line grammar).
function limb(ctx, pts, colour, w, h) {
  const lw = Math.max(3, w * 0.006);
  ctx.lineWidth = lw; ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.strokeStyle = colour;
  ctx.beginPath();
  pts.forEach((pt, i) => (i ? ctx.lineTo(pt.x * w, pt.y * h) : ctx.moveTo(pt.x * w, pt.y * h)));
  ctx.stroke();
  ctx.fillStyle = colour;
  for (const pt of pts) { ctx.beginPath(); ctx.arc(pt.x * w, pt.y * h, lw * 1.15, 0, Math.PI * 2); ctx.fill(); }
}

// One label, at the joint it measures, no leader line.
function tag(ctx, text, at, colour, w, h) {
  const size = Math.max(15, w * 0.045);
  ctx.font = `600 ${size}px "Barlow Condensed", "Arial Narrow", Arial, sans-serif`;
  const tw = ctx.measureText(text).width, padX = size * 0.45, padY = size * 0.26;
  const bw = tw + padX * 2, bh = size + padY * 2;
  const bx = Math.min(Math.max(at.x * w + size * 0.55, 4), w - bw - 4);
  const by = Math.min(Math.max(at.y * h - bh / 2, 4), h - bh - 4);
  ctx.fillStyle = "rgba(11,11,11,.78)";
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, size * 0.34); else ctx.rect(bx, by, bw, bh);
  ctx.fill();
  ctx.fillStyle = colour;
  ctx.fillText(text, bx + padX, by + size + padY * 0.05);
}

const SEEN = (pt) => (pt?.visibility ?? 1) > 0.5;

/* ---- How sure are we, really? --------------------------------------------

   The spread of your individual pedal strokes says how variable YOU are. It
   does not say how well we know your typical position — averaging sixteen
   strokes locates that centre far better than any single stroke does. The old
   rule compared the band edge against the raw stroke spread, which conflated
   the two, and the cost was not theoretical: with a spread near ±4.5° it made
   most of the 30–40° band unjudgeable by construction. Five honest rides in a
   row came back "too close to call" while the app kept asking for a sixth.

   So: the uncertainty that decides a verdict is the standard error of the
   centre, plus a floor for the errors that averaging cannot remove. */
export function uncertainty(m) {
  const n = Math.max(1, m.n ?? m.strokes ?? 1);
  return Math.sqrt((m.sd ?? 0) ** 2 / n + ANGLE_FLOOR_DEG ** 2);
}

export function verdictWith(value, u, [lo, hi]) {
  if (!Number.isFinite(value)) return null;
  const margin = VERDICT_SIGMAS * u;
  if (value >= lo && value <= hi)
    return Math.min(value - lo, hi - value) >= margin ? "ok" : "borderline";
  const out = value < lo ? lo - value : value - hi;
  if (out < margin) return "borderline";
  return value < lo ? "low" : "high";
}

export const verdictFor = (m, band) => (m ? verdictWith(m.value, uncertainty(m), band) : null);

/* Pools this ride with earlier ones. Each ride is an independent estimate —
   its own camera placement, its own day — so the scatter BETWEEN rides
   contains the setup and landmark error that a single ride can only assume a
   value for. At three rides that scatter is measured rather than assumed,
   which is what finally lets a close call be settled instead of deferred. */
/* One reader for a stored knee measurement, used everywhere. Home accepted
   `.mean` (written by older rows) while the analysis only accepted `.value`,
   so the two screens pooled different numbers of rides and printed different
   ride counts for the same rider on the same evening. */
export function kneeReadOf(report) {
  const k = report?.kneeBendBDC;
  const value = k?.value ?? k?.mean;
  if (!Number.isFinite(value)) return null;
  /* How this one was measured, so it is never averaged with readings taken a
     different way. An angle read off the flat picture and an angle
     reconstructed in three dimensions are not the same quantity. */
  return { value, sd: k.sd ?? 0, n: k.strokes ?? 1,
           era: report?.howRead ? ERA : "flat" };
}

/* WHICH RIDES CAN BE COMPARED WITH EACH OTHER.

   A rider opened the app to "we measured your knee on 17 rides and got a
   different answer nearly every time — 27° at the lowest, 39° at the highest".
   Thirteen of those seventeen were measured before we started reconstructing
   the angle in three dimensions. The four taken since sit at 33.4, 32.8, 34.1
   and 34.2 — a spread of 1.4°, against 3.6° for the same four read the old way.

   So that 27-to-39 spread was a record of our own changes presented to a rider
   as instability in their riding, and it was blocking an answer they had
   already earned. When the way we measure changes, everything before it is
   history: keep it on the chart, keep it out of the average. */
const ERA = "3d";
export function comparable(reads) {
  const list = (reads ?? []).filter(Boolean);
  const now = list.filter((r) => r.era === ERA);
  return now.length ? now : list;      // nothing current yet: the old set stands
}

export function pool(reads) {
  const clean = (reads ?? []).filter((r) => r && Number.isFinite(r.value));
  if (!clean.length) return null;
  const vals = clean.map((r) => r.value);
  const centre = median(vals);
  if (clean.length === 1)
    return { value: centre, u: uncertainty(clean[0]), rides: 1, vals, settled: false, lo: centre, hi: centre };
  const between = sd(vals) / Math.sqrt(vals.length);
  /* Never claim to be surer than one ride's own floor divided across the rides
     — a run of rides that happen to agree closely is not proof the camera was
     in the same place each time. */
  const u = Math.max(between, ANGLE_FLOOR_DEG / Math.sqrt(vals.length));
  return {
    value: centre, u, rides: vals.length, vals,
    settled: vals.length >= SETTLE_RIDES,
    lo: Math.min(...vals), hi: Math.max(...vals),
  };
}

/* iOS will not decode a frame from a video element that has never played, and
   a frame that was never decoded is exactly what drawImage copies: solid
   black. Playing a muted, inline video needs no user gesture, so a play/pause
   before we start reading is what makes the pixels exist at all. This is why
   the report's stills came back black with the skeleton floating on nothing. */
/* A <video> that is not in the document has no painted frame for a 2D canvas
   to copy, and display:none is just as dead — both give drawImage a black
   rectangle. The pose model reads the element through a different path and
   sees frames either way, which is why the numbers looked fine while the
   stills came back empty. So: really in the page, really laid out, one pixel,
   and invisible. */
function offscreenVideo() {
  const v = document.createElement("video");
  v.muted = true; v.playsInline = true; v.preload = "auto";
  v.setAttribute("aria-hidden", "true");
  v.style.cssText = "position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1";
  document.body.appendChild(v);
  return v;
}

async function primeVideo(video) {
  video.muted = true; video.playsInline = true;
  try { await video.play(); } catch { return false; }
  video.pause();
  return true;
}

/* "seeked" fires when the seek has completed, not when the new frame has been
   presented to the compositor. Drawing in the gap copies the previous frame,
   or none at all. requestVideoFrameCallback is the only event that means "a
   frame is now on screen"; where it does not exist the seek is the best signal
   available, so this resolves either way and never blocks the report. */
function paintedFrame(video, budgetMs = 900) {
  if (typeof video.requestVideoFrameCallback !== "function") return Promise.resolve(false);
  return new Promise((res) => {
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; res(ok); } };
    const id = video.requestVideoFrameCallback(() => done(true));
    setTimeout(() => { try { video.cancelVideoFrameCallback?.(id); } catch {} done(false); }, budgetMs);
  });
}

/* A still with no variation in it is a frame that never decoded. Shipping one
   would put a measurement overlay on a black rectangle — a drawing with
   nothing underneath, which is worse than showing no still at all. */
export function hasPicture(ctx, w, h) {
  const { data } = ctx.getImageData(0, 0, w, h);
  let lo = 255, hi = 0;
  const step = Math.max(4, Math.floor((w * h) / 4000)) * 4;
  for (let i = 0; i < data.length; i += step) {
    const v = (data[i] + data[i + 1] + data[i + 2]) / 3;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return hi - lo > 6;
}

/* Grab the frame a number actually came from and draw that number on it.
   `draw` returns false when the joints it needs are not visible in this exact
   frame — then the still is shown with nothing drawn rather than a guess. */
async function still(video, lm, t, draw, side, maxW = 720) {
  /* The sampling pass leaves the video at the end of the clip, so grabbing a
     keyframe means a long seek backwards — and in a MediaRecorder file, which
     carries no seek index, that is far slower than the forward steps the loop
     makes. The loop's 2.5s budget silently turned every keyframe into null and
     the report lost its stills. Rewind first, then go forward to the frame,
     with a budget that suits a one-off. */
  if (!(await seekTo(video, t, 8000))) return { fail: "the clip would not seek to that moment" };
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return { fail: "the video reported no size" };
  const scale = Math.min(1, maxW / vw);
  const c = document.createElement("canvas");
  c.width = Math.round(vw * scale); c.height = Math.round(vh * scale);
  const ctx = c.getContext("2d", { willReadFrequently: true });

  await paintedFrame(video);
  ctx.drawImage(video, 0, 0, c.width, c.height);
  if (!hasPicture(ctx, c.width, c.height)) {
    // One retry: prime the decoder, land on the frame again, and look once more.
    await primeVideo(video);
    await seekTo(video, Math.max(0, t - 0.2), 4000);
    await seekTo(video, t, 4000);
    await paintedFrame(video);
    ctx.drawImage(video, 0, 0, c.width, c.height);
    if (!hasPicture(ctx, c.width, c.height)) return { fail: "the frame decoded blank on this device" };
  }

  const p = lm.detectForVideo(video, performance.now()).landmarks?.[0];
  /* The draw callback returns the points it drew, or false when the joints it
     needs are not visible in this exact frame. */
  /* side === null hands the draw callback the raw landmark array. The side
     view wants one leg picked for it; the front and rear views need both
     sides at once, so they take the landmarks as they come. */
  /* `t` goes to the callback as well: the front view rebuilds occluded knees,
     and a reconstruction needs to know which of two mirrored answers is the
     rider's. The settled row at this moment already knows. */
  const focus = p ? draw(ctx, side ? pickSide(p, side) : p, c.width, c.height, t) : false;
  const drawn = focus !== false;
  return { src: crop(c, drawn ? focus : null), drawn };
}

/* Work down the ranked frames until one produces a still with the measurement
   actually drawn on it. Only if every attempt comes back undrawable do we
   settle for a picture with nothing on it — and only if the clip will not give
   a picture at all is there no still. Bounded, because each try is a seek. */
async function bestStill(video, lm, times, draw, side, tries = 6) {
  let fallback = null;
  for (const t of times.slice(0, tries)) {
    const shot = await still(video, lm, t, draw, side);
    if (shot.fail) { fallback ??= shot; continue; }
    if (shot.drawn) return shot;
    fallback = shot;                       // a real frame, just nothing drawable on it
  }
  return fallback ?? { fail: "no frame in the clip could be read" };
}

/* A whole portrait phone frame per card turns the report into a scroll of
   living rooms. Crop to what is being measured — the joints, with enough
   around them to see it is a person on a bike — and the evidence gets both
   clearer and shorter. */
function crop(src, points, maxW = 640) {
  if (!points?.length) return src.toDataURL("image/jpeg", 0.82);
  const xs = points.map((q) => q.x), ys = points.map((q) => q.y);
  let x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  // Generous padding: a knee angle in isolation is unreadable, a knee angle
  // with the bike around it is obvious.
  const padX = Math.max(0.10, (x1 - x0) * 0.75), padY = Math.max(0.06, (y1 - y0) * 0.35);
  x0 -= padX; x1 += padX; y0 -= padY; y1 += padY;

  // Keep it from becoming a letterbox slit either way.
  const wantAR = 4 / 3;
  let w = (x1 - x0) * src.width, h = (y1 - y0) * src.height;
  let cx = ((x0 + x1) / 2) * src.width, cy = ((y0 + y1) / 2) * src.height;
  if (w / h < wantAR) w = h * wantAR; else h = w / wantAR;
  w = Math.min(w, src.width); h = Math.min(h, src.height);
  cx = Math.min(src.width - w / 2, Math.max(w / 2, cx));
  cy = Math.min(src.height - h / 2, Math.max(h / 2, cy));

  const out = document.createElement("canvas");
  const scale = Math.min(1, maxW / w);
  out.width = Math.round(w * scale); out.height = Math.round(h * scale);
  out.getContext("2d").drawImage(src, cx - w / 2, cy - h / 2, w, h, 0, 0, out.width, out.height);
  return out.toDataURL("image/jpeg", 0.85);
}

// Dashed = a reference, never the rider's own body (line grammar).
function plumb(ctx, from, to, colour, w, h) {
  ctx.save();
  ctx.setLineDash([Math.max(5, w * 0.012), Math.max(5, w * 0.012)]);
  ctx.lineWidth = Math.max(2, w * 0.004);
  ctx.strokeStyle = colour;
  ctx.beginPath();
  ctx.moveTo(from.x * w, from.y * h);
  ctx.lineTo(to.x * w, to.y * h);
  ctx.stroke();
  ctx.restore();
}

function dot(ctx, pt, colour, w, h) {
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.arc(pt.x * w, pt.y * h, Math.max(4, w * 0.008), 0, Math.PI * 2);
  ctx.fill();
}

/* How much the footage can be trusted, from the footage itself.

   Squareness: filmed truly side-on, the two hips project onto nearly the same
   point; as the phone rotates off-axis they separate. Dividing that separation
   by trunk length and assuming a population hip-to-trunk proportion turns it
   into an approximate yaw. It is an estimate of the CAMERA, not of the rider,
   and it only ever downgrades a report — it never invents a coaching number.

   Detection and visibility are the model's own account of whether it saw you,
   so those can refuse a read outright. */
function gradeCapture(frames) {
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
  const detection = frames.sampled ? frames.seen / frames.sampled : 0;
  const visibility = med(frames.vis);
  const clipped = frames.seen ? frames.clipped / frames.seen : 0;

  const ratio = med(frames.hipSpread);
  const offSquareDeg = +(deg(Math.asin(Math.min(1, ratio / CAPTURE.hipWidthOverTrunk)))).toFixed(0);

  /* A refusal carries the counts that caused it. Without them the rider is
     told to reframe a shot that may have been framed perfectly, and we cannot
     tell a badly-filmed clip from a clip this phone would not decode. */
  const counted = { sampled: frames.sampled, found: frames.seen,
                    detection: +detection.toFixed(2), visibility: +visibility.toFixed(2) };
  if (detection < CAPTURE.minDetection)
    return { grade: "F", ...counted,
      reason: `We could only find you in ${frames.seen} of the ${frames.sampled} frames we looked at. Get the whole bike and rider in frame, in decent light, and film again.` };
  if (visibility < CAPTURE.minVisibility)
    return { grade: "F", ...counted,
      reason: "We found you, but your hip, knee and ankle were never clearly enough in view to measure. Stand back until the whole bike is inside the frame on screen, put the saddle on the dashed line, and film again." };

  /* The squareness estimate is not trusted enough to suppress a measurement
     yet: it read 21° on footage with 99% detection and 92% visibility, which
     is a well-shot clip. The far hip is a low-confidence guess in a true side
     view, so the separation it implies is probably the estimator's floor
     rather than the camera's angle. It still reports, so it can be checked
     against real clips — it just no longer overrides a good read. Flip
     squarenessGates once the number has been shown to track reality. */
  const offSquare = CAPTURE.squarenessGates && offSquareDeg > CAPTURE.offSquareMaxDeg;
  const provisional = offSquare || clipped > CAPTURE.maxClipped;
  return {
    grade: provisional ? "C" : offSquareDeg > CAPTURE.offSquareWarnDeg ? "B" : "A",
    offSquareDeg, clipped: +clipped.toFixed(2),
    hipSpread: +ratio.toFixed(3),          // raw signal, kept for calibration
    squarenessGates: CAPTURE.squarenessGates,
    detection: +detection.toFixed(2), visibility: +visibility.toFixed(2),
    reason: !provisional ? null
      : offSquare
        ? `The phone looks about ${offSquareDeg}° off square to the bike. Angles read off an angled view are stretched, so this ride's numbers are provisional.`
        : "Part of you left the frame during the stroke, so this ride's numbers are provisional.",
  };
}

/* Both extra views watch the frontal plane, where the honest unit is an angle
   from vertical — scale-free, so it needs no calibration. Neither carries a
   verdict band: no cited research band exists in the project for frontal-plane
   knee travel or pelvic rock, and inventing one is exactly what rule 4 forbids.
   Left-versus-right asymmetry IS judged, because it compares the rider to
   themselves and needs no external threshold. */

/* A MediaRecorder blob reports duration Infinity on a fresh element until its
   end has been seeked. Sampling past that point makes currentTime clamp, which
   fires no "seeked" at all — the old code then waited on an event that would
   never come and the analysis hung with the bar frozen. */
async function settleDuration(video) {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  await new Promise((resolve) => {
    const done = () => { video.removeEventListener("timeupdate", done); resolve(); };
    video.addEventListener("timeupdate", done);
    video.currentTime = 1e101;
    setTimeout(done, 2000);
  });
  video.currentTime = 0;
  return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
}

// Resolves false when the seek never lands, so one bad frame costs a frame
// rather than the whole run.
function seekTo(video, t, budgetMs = 2500) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      video.removeEventListener("seeked", onSeeked);
      clearTimeout(timer);
      resolve(ok);
    };
    const onSeeked = () => finish(true);
    video.addEventListener("seeked", onSeeked);
    const timer = setTimeout(() => finish(false), budgetMs);
    try { video.currentTime = t; } catch { finish(false); }
  });
}

/* WHY THE SWEEP DOES NOT WAIT FOR A PAINTED FRAME.
   It is tempting: "seeked" means the seek finished, not that the new frame has
   been presented, so a detect() straight after a seek looks like it could be
   reading the previous frame. paintedFrame() was added to both sweeps on that
   reasoning in v22 and reverted in v23, because the rider's own sessions said
   otherwise on both counts.

   It did not fix anything. Detection came back at 1.00 on the side view in
   every session before the change and every session after it; the single
   failed read it was meant to explain sat between two perfect ones.

   And it cost a great deal. requestVideoFrameCallback fires when a frame is
   PRESENTED, and this element is a paused 1px video that presents nothing, so
   every sample burned the whole 250 ms budget: the side pass went from 14 s to
   46 s. Worse, by the time the front clip opened, seeking had stopped working
   altogether — 163 frames sampled with no failures before the change, 6
   sampled with 5 seek failures after it, and both extra views refused for
   footage that had been fine the day before.

   If a frame really does need to be settled, the accurate re-read pass is
   where to do it — it reads a few dozen frames, not two thousand.

   `after` runs once the clip has been sampled and BEFORE the video is
   released — the only moment the front and rear views can pull a still, since
   everything they know about the clip dies with that element. */
async function sampleFrames(blob, [t0, t1], onProgress, fps, seconds, read, after) {
  const lm = await getLandmarker();
  const video = offscreenVideo();
  const srcUrl = URL.createObjectURL(blob);
  video.src = srcUrl;
  const release = () => { video.src = ""; URL.revokeObjectURL(srcUrl); video.remove(); };
  try {
    await new Promise((res, rej) => {
      video.onloadedmetadata = res;
      video.onerror = () => rej(new Error("could not read the video"));
    });
    await primeVideo(video);
    const sq = squareUp((video.videoWidth || 1) / (video.videoHeight || 1));
    const dur = await settleDuration(video);
    const end = Math.min(t1, dur || t1, t0 + seconds);
    const total = Math.max(1, Math.round((end - t0) * fps));
    const rows = [];
    const stat = { sampled: 0, posed: 0, seekFails: 0, kept: 0, span: +(end - t0).toFixed(1) };
    let missed = 0;
    for (let t = t0, i = 0; t < end; t += 1 / fps, i++) {
      stat.sampled++;
      if (!(await seekTo(video, t))) {
        stat.seekFails++;
        if (++missed >= 5) break;        // the clip has stopped giving frames
        continue;
      }
      missed = 0;
      const p = lm.detectForVideo(video, performance.now()).landmarks?.[0];
      // The frame's own time, not the time we asked to seek to — the overlay
      // rides on this, and a request is not a position.
      if (p) { stat.posed++; const row = read(p, sq, video.currentTime); if (row) { stat.kept++; rows.push(row); } }
      onProgress?.(i / total);
    }
    rows.stat = stat;
    if (after && rows.length) {
      // Sampling ends at the far end of the clip, so wind back before asking
      // for a frame from the middle of it.
      try {
        if (await seekTo(video, 0, 6000)) rows.stills = await after(video, lm, rows);
      } catch { /* a view without a still still reports its numbers */ }
    }
    return rows;
  } finally { release(); }
}

// Angle of a limb from vertical in the frontal plane; sign is +inward (medial).
function fromVertical(top, bottom, inwardIsPositive) {
  const dx = bottom.x - top.x, dy = bottom.y - top.y;
  const a = deg(Math.atan2(dx, Math.abs(dy) + 1e-9));
  return inwardIsPositive ? a : -a;
}

const pct = (a, q) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};

/* How far a thing swings, measured so that one bad frame cannot define it.
   max minus min is the least robust statistic there is — it is computed
   ENTIRELY from the two most extreme readings in the clip, so a single frame
   where the model mislabels a joint sets the answer by itself. That is how a
   pelvis came to be reported as rocking 127 degrees. The 10th-to-90th
   percentile spread says the same thing about the rider and nothing about the
   worst two frames. */
const amplitude = (a) => (a.length < 8
  ? Math.max(...a) - Math.min(...a)
  : pct(a, 0.9) - pct(a, 0.1));

/* Which pose to draw at a given moment of playback, if any.
   Returns null when the nearest analysed frame is too far away — the model
   found nothing there, and a stale skeleton on a moving rider is exactly the
   "drawing without a measurement" the rules forbid. */
/* The clip is sampled at 15 fps and plays at 30 or 60, so snapping to the
   nearest sample leaves the skeleton up to a frame and a half behind the leg —
   at 85 rpm that is a visible chunk of a pedal stroke. Interpolate between the
   two samples either side instead, and only give up when the gap is genuinely
   too wide to bridge (the model lost the rider there, and nothing is drawn). */
export function overlayAt(track, t, tol = 0.12) {
  if (!track?.length) return null;
  let lo = 0, hi = track.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (track[mid].t < t) lo = mid + 1; else hi = mid; }
  const b = track[lo], a = track[Math.max(0, lo - 1)];
  const near = Math.abs(a.t - t) <= Math.abs(b.t - t) ? a : b;
  if (Math.abs(near.t - t) > tol) return null;

  const [bLo, bHi] = BANDS.kneeBendBDC;
  const span = b.t - a.t;
  // Same sample on both sides, or a gap wide enough that sliding between them
  // would invent a position the rider never held.
  if (a === b || span <= 0 || span > tol) {
    return typeof near.knee === "number"
      ? { ...near, inBand: near.knee >= bLo && near.knee <= bHi }
      : { ...near };
  }
  const f = Math.min(1, Math.max(0, (t - a.t) / span));
  const mix = (x, y) => x + (y - x) * f;
  const j = {};
  for (const key of Object.keys(a.j)) {
    if (!b.j[key]) continue;                      // a joint the model lost
    j[key] = { x: mix(a.j[key].x, b.j[key].x), y: mix(a.j[key].y, b.j[key].y) };
  }
  /* Interpolate whatever numbers the track carries rather than only the knee:
     the front view tracks each leg's lean, the rear tracks shoulder and pelvis
     tilt, and the player draws all three from this one function. */
  const out = { t, j };
  for (const [key, v] of Object.entries(a)) {
    if (key === "t" || key === "j" || typeof v !== "number") continue;
    out[key] = typeof b[key] === "number" ? mix(v, b[key]) : v;
  }
  if (typeof out.knee === "number") out.inBand = out.knee >= bLo && out.knee <= bHi;
  return out;
}

/* How far a knee leans off vertical, per leg, in the frontal plane — and the
   linkage that makes those readings survive a bike being in the way.

   From the front the model's hardest problem is not the rider, it is the bike:
   bars, brake hoods, a top tube and two forearms all cross the legs, and every
   one of them is a plausible-looking place to put a "knee". Checking each
   frame against anatomy and discarding what fails is honest but wasteful — and
   it still lets through a knee that happens to sit below the hip while being
   nowhere near the leg.

   A body is a linkage. This rider's thigh is the same length in every frame,
   so once it has been measured from the frames the model clearly got right,
   the knee in every other frame is not a guess: it is the intersection of a
   circle of one femur about the hip with a circle of one tibia about the
   ankle. Two answers at most, and the previous frame says which.

   Both are pure and exported, so the geometry can be driven from a test
   without a video in front of it. */
const FRONT_FPS = 12;
const LEGS = ["l", "r"];

/* One frame's two legs, in squared coordinates.
   `clean` — the model's own reading is anatomically possible: a seated
   rider's knee is always below their hip and their ankle always below their
   knee. Only clean legs are allowed to define the rider's bone lengths.
   `ends` — the hip and the ankle can be trusted even when the knee between
   them cannot. That is the case the geometry exists for. */
export function frontLegs(p, sq) {
  const vis = (i) => (p[i].visibility ?? 1) >= CAPTURE.minJointVisibility;
  /* THE ENDS HAVE TO BE ON THE BODY, not just visible and the right way up.
     This is the hole the linkage work left. bestLeg() questions the knee and
     trusts the hip and the ankle absolutely — so when the model puts a "hip"
     up on a shoulder and an "ankle" down on a hand, the two circles still
     intersect somewhere, and it draws a confident, geometrically perfect leg
     across a rider's arm. Reconstruction makes a bad read look MORE certain,
     not less, which is exactly the wrong way round.

     A hip is below both shoulders. That is cheap, it is always true of someone
     sitting on a bike, and it is the check that would have caught it. */
  const belowShoulders = Math.max(p[11]?.y ?? -1, p[12]?.y ?? -1);
  const leg = (h, k, a) => {
    /* "Below the shoulders" is not enough on its own — a hip one per cent of
       the frame under a shoulder passes that and is still a shoulder. Measure
       it against the body's own height in frame: from the shoulders down to
       this ankle, a hip sits somewhere near the middle, never in the top
       sixth. Scale-free, so it holds whether the rider fills the frame or
       stands six metres back. */
    const body = p[a].y - belowShoulders;
    const ends = vis(h) && vis(a) && p[a].y > p[h].y
      && body > 0 && (p[h].y - belowShoulders) > 0.15 * body;
    return {
      hip: sq(p[h]), knee: sq(p[k]), ankle: sq(p[a]), ends,
      clean: ends && vis(k) && p[k].y > p[h].y && p[a].y > p[k].y,
    };
  };
  return { l: leg(23, 25, 27), r: leg(24, 26, 28) };
}

/* Pass two: measure this rider, then hold every frame to them. Runs once —
   it is called from the still hook, which fires while the video is still
   open, and again afterwards for the case where the clip gave no still. */
export function settleFrontLegs(rows, fps = FRONT_FPS) {
  if ("bones" in rows) return rows.bones;
  const clean = [];
  for (const r of rows) for (const s of LEGS) if (r.legs[s].clean) clean.push(r.legs[s]);
  const bones = boneLengths(clean);
  rows.bones = bones;
  const tally = { measured: 0, rebuilt: 0, dropped: 0,
    femur: bones ? +bones.femur.toFixed(3) : null,
    tibia: bones ? +bones.tibia.toFixed(3) : null,
    from: bones ? bones.from : 0 };
  rows.repair = tally;

  const last = { l: null, r: null };
  for (const r of rows) {
    r.j = {};
    const held = {};
    for (const s of LEGS) {
      const leg = r.legs[s];
      if (!leg.ends) continue;
      const prev = last[s];
      /* A knee that fails the anatomy check is never accepted as measured,
         however well its bone lengths happen to come out — it goes in as a
         hint for which of the two mirrored answers is the rider's, and the
         geometry decides where it actually was. Without bone lengths there is
         nothing to check against at all, so the old rule stands: take the
         frames anatomy allows and drop the rest. */
      const best = bones
        ? bestLeg({ hip: leg.hip, knee: leg.clean ? leg.knee : null, ankle: leg.ankle },
                  bones, prev?.knee ?? leg.knee)
        : (leg.clean ? { ...leg, repaired: false } : null);
      /* A knee cannot teleport. Between two adjacent samples it moves a
         fraction of a thigh; a jump of a whole thigh means the ends the
         reconstruction trusted were not the rider's after all. */
      const jumped = !!bones && !!prev && r.t - prev.t <= 1.5 / fps &&
        movedTooFar(prev.knee, best?.knee, bones.femur * SANITY.kneeStepOverFemur);
      if (!best || jumped) { tally.dropped++; continue; }
      if (best.repaired) tally.rebuilt++; else tally.measured++;
      last[s] = { knee: best.knee, t: r.t };
      held[s] = best;
    }

    /* Which leg is which, by screen position rather than the model's own
       left/right labels — facing the camera it swaps those readily, and a
       swap moves one leg's lean into the other leg's series. A rider faces
       us, so the leg on the left of frame is their right.
       Mid-frame is half the SQUARED width, not 0.5: x has been multiplied by
       the aspect ratio, so on portrait video the centre line sits nearer
       0.28 — and a lone visible leg anywhere in between was being credited
       to the wrong side of the body. */
    const shown = LEGS.filter((s) => held[s]);
    const leftMost = shown.length === 2 ? (held.l.knee.x <= held.r.knee.x ? "l" : "r") : null;
    const raw = (j) => ({ x: +(j.x / r.ar).toFixed(4), y: +j.y.toFixed(4) });
    for (const s of shown) {
      const onScreenLeft = leftMost ? s === leftMost : held[s].knee.x < r.ar / 2;
      const lean = fromVertical(held[s].knee, held[s].ankle, !onScreenLeft);
      // A knee does not leave vertical by this much, however it was arrived at.
      if (Math.abs(lean) > SANITY.kneeLeanDeg) continue;
      r[onScreenLeft ? "right" : "left"] = lean;
      if (held[s].repaired) r.rebuilt = true;
      /* Raw image coordinates travel with the row so the player can replay
         this clip with the same lines drawn on it — including the thigh,
         which is the part the reconstruction is responsible for and so the
         part worth being able to look at. */
      r.j[`${s}hip`] = raw(held[s].hip);
      r.j[`${s}knee`] = raw(held[s].knee);
      r.j[`${s}ankle`] = raw(held[s].ankle);
    }
    if (!Object.keys(r.j).length) r.j = null;
  }
  return bones;
}

/* WHERE THIS RIDER STANDS — one answer, computed once, used by the home
   screen and by the report, so the two can never tell different stories about
   the same rides on the same day. They did: home said "you ride at the
   straighter end, ride after ride — so it is where you ride, not a shaky
   reading" while the report, two taps away, said "we got a different answer
   nearly every time, they cannot all be right". Home had no test for rides
   that disagree with each other; it just averaged them and sounded sure.

   And the wording: a rider does not need to be told our reading is not shaky.
   That is us reassuring ourselves about our own measurement. What they need is
   what their leg is doing, where the work is landing, and whether to touch
   anything. Every line below says those three things and stops. */
export function standing(reads) {
  const across = pool(comparable(reads));
  if (!across) return null;
  const [lo, hi] = BANDS.kneeBendBDC;
  const v = across.value, n = across.rides;
  const rides = `${n} ride${n > 1 ? "s" : ""}`;
  const deg = v.toFixed(0);
  const verdict = verdictWith(v, across.u, BANDS.kneeBendBDC);
  const sameSide = across.vals.every((x) => x < lo) || across.vals.every((x) => x > hi);
  const straighter = v < (lo + hi) / 2;      // less bend = saddle nearer too high

  /* Rides that disagree with each other by more than the whole range are not a
     position, whatever their average comes out as. */
  /* This is the first thing anyone reads when they open the app, so it opens
     with the rider, not with us. "We can't call your saddle height yet" is an
     apology as a welcome screen: three lines about our own difficulty before a
     single word about them. Lead with what their leg is doing, which we do
     know, and put what is missing after it. */
  if (across.settled && !sameSide && across.hi - across.lo > hi - lo)
    return { word: "Not settled",
      head: `Your knee bends around ${deg}° at the bottom`,
      line: `Across ${rides} it has come out as low as ${across.lo.toFixed(0)}° and as high as ${across.hi.toFixed(0)}°, and nothing on your bike changed in between — so something in the filming did. Film one more from the side with the whole bike in the box on screen, and we can tell you whether that leg wants more room or less.` };

  if (verdict === "ok")
    return { word: "Good",
      head: "Your saddle height is doing its job",
      line: `Your knee bends ${deg}° at the bottom of each stroke, in the middle of where riders sit. Your leg is finishing the push with the big muscles above the knee, which is where you want the work. Nothing to change — film again if you move the saddle or change shoes.` };

  if (across.settled && verdict === "borderline")
    return straighter
      ? { word: "Just inside",
          head: "Your saddle sits at the top of its useful range",
          line: `At the bottom of each stroke your leg straightens almost fully — ${deg}°, where riders sit between ${lo}° and ${hi}°. It works, but the last part of every push lands on the back of your knee and the hamstring rather than the big muscles above. If long rides ache behind the knee, take 2–3 mm out of the saddle and see how that feels.` }
      : { word: "Just inside",
          head: "Your saddle sits at the bottom of its useful range",
          line: `Your knee stays quite bent at the bottom of each stroke — ${deg}°, where riders sit between ${lo}° and ${hi}°. It works, but you never quite get through the strongest part of the push, and the front of the knee carries more of it. If you want more to lean on when the road tips up, add 2–3 mm and see how that feels.` };

  if (verdict === "borderline")
    return { word: "Not settled",
      head: `Your knee bends around ${deg}° at the bottom`,
      line: `That sits right on the edge of where riders sit, and ${n} ride${n > 1 ? "s" : ""} is not quite enough to say which side of it you are on. Film one more from the same spot and we can tell you whether your leg is straightening too far at the bottom of the stroke, not far enough, or is fine exactly where it is.` };

  return straighter
    ? { word: "Worth a change",
        head: "Your saddle looks too high",
        line: `Your leg straightens to ${deg}° at the bottom, where riders sit between ${lo}° and ${hi}°. Reaching that far for the pedal rocks your hips side to side and puts the end of every push behind the knee. Drop the saddle 5 mm, ride a minute, and film it again.` }
    : { word: "Worth a change",
        head: "Your saddle looks too low",
        line: `Your knee is still bent ${deg}° at the bottom, where riders sit between ${lo}° and ${hi}°. You never get through the strongest part of the push, and the front of the knee takes what is left. Raise the saddle 5 mm, ride a minute, and film it again.` };
}

/* WHAT TO DO NEXT — the reason to open this again.

   The home screen ended at "your saddle height is doing its job, nothing to
   change". True, useful once, and a dead end: a rider who has settled the one
   setting the app talks about has been told, politely, that they are finished
   with it. Saddle height is not the product. It is the first of several things
   the app can see, and the only one it was ever pointing at.

   So once it is settled, say what is still unanswered and hand over the one
   action that answers it. Ranked by how much is behind the door: an angle
   never read at all outranks a number that could be sharper, and both outrank
   "come back in a month". `null` means the card above already IS the next
   step — an unsettled saddle is asking for a ride, and asking twice on one
   screen is nagging. */
export function nextStep(stand, views = {}) {
  if (!stand) return null;                     // no rides yet: the empty state has its own words
  if (stand.word !== "Good" && stand.word !== "Just inside") return null;

  if (!views.front)
    return { head: "Find out whether your knees track straight",
      line: "Filmed from the side, a knee sliding in or out of line is invisible — the leg just looks like it is going up and down. From the front it is obvious, and it is the movement behind most aches on the inside or the outside of the knee. Cleat position is usually what moves it.",
      act: "Film the front view", to: "#/analyze" };

  if (!views.rear)
    return { head: "Find out whether you sit level",
      line: "From behind you can see whether your hips stay level or roll from side to side chasing the pedals. Every bit of that roll is effort moving you about instead of moving the bike, and it is the check that either backs up your saddle height or argues with it.",
      act: "Film from behind", to: "#/analyze" };

  return { head: "Find out whether it made you faster",
    line: "Your position is settled and all three angles read clean, so the question stops being what to change and starts being what the changes did. Pair your rides and we will put the same effort before and after a change side by side — power for the heart rate it cost, which is the part you feel on a long day.",
    act: "Connect your rides", to: "#/connect" };
}

/* FRONT VIEW — the clip-level pass: sample the frames, settle the linkage,
   then report knee travel and left/right evenness from what survived. */
export async function analyzeFrontClip(blob, trim, onProgress) {
  /* The frame worth showing from the front is the one where a knee is furthest
     from vertical — the moment the number is describing. Captioned as the
     extreme it is, not as a typical stroke. */
  const frontStill = async (video, lm, rows) => {
    const bones = settleFrontLegs(rows);
    const lean = (r) => Math.max(Math.abs(r.left ?? 0), Math.abs(r.right ?? 0));
    const ranked = rows.map((_, i) => i).filter((i) => rows[i].j)
      .sort((a, b) => lean(rows[b]) - lean(rows[a]));
    if (!ranked.length) return null;
    const worst = ranked[0];
    const shot = await bestStill(video, lm, ranked.map((i) => rows[i].t), (ctx, p, w, h, at) => {
      /* The picture goes through the same linkage as the numbers, on this
         frame's own landmarks — so a knee the measurement rebuilt is the knee
         the still draws, and the two cannot disagree about the same frame. */
      const ar = w / h;
      const legs = frontLegs(p, squareUp(ar));
      const un = (j) => ({ x: j.x / ar, y: j.y });
      // The settled row at this moment, to hint which way the knee bends.
      const near = rows.reduce((b, r) => (r.j && Math.abs(r.t - at) < Math.abs(b.t - at) ? r : b), rows[worst]);
      const drew = [];
      for (const s of LEGS) {
        if (!legs[s].ends) continue;
        const settled = near.j?.[`${s}knee`];
        const hint = settled ? { x: settled.x * ar, y: settled.y } : legs[s].knee;
        const best = bones
          ? bestLeg({ hip: legs[s].hip, knee: legs[s].clean ? legs[s].knee : null, ankle: legs[s].ankle }, bones, hint)
          : (legs[s].clean ? legs[s] : null);
        if (!best) continue;
        const hip = un(best.hip), knee = un(best.knee), ankle = un(best.ankle);
        plumb(ctx, ankle, { x: ankle.x, y: knee.y }, "#9C9A93", w, h);
        limb(ctx, [hip, knee, ankle], OUT_OF_BAND, w, h);
        drew.push(hip, knee, ankle);
      }
      if (!drew.length) return false;
      tag(ctx, `${lean(rows[worst]).toFixed(0)}°`, drew[1], OUT_OF_BAND, w, h);
      return drew;
    }, null);
    return shot.fail ? null : {
      knees: { ...shot,
        /* Say how this frame relates to the card. One frame shows a knee at an
           instant; the card reports how far it SWINGS across a whole stroke.
           Printing one number under the other without saying which is which is
           how a card came to read 22 degrees above a picture saying 52. */
        caption: `The furthest your knee sat from vertical in this clip — ${lean(rows[worst]).toFixed(0)}° at this instant. The card above is how far it swings across a whole stroke. Dashed lines run straight up from each ankle.` },
    };
  };

  /* Pass one keeps joints and decides nothing. Bone lengths can only be taken
     once the whole clip has been seen, and every frame's verdict needs them. */
  const rows = await sampleFrames(blob, trim, onProgress, FRONT_FPS, 40, (p, sq, t) => {
    /* Each leg stands on its own. Requiring both at once threw the whole frame
       away whenever the far ankle passed behind the cranks — which is most of
       the stroke — and one measured leg is still worth saying. */
    const legs = frontLegs(p, sq);
    if (!legs.l.ends && !legs.r.ends) return null;
    // sq multiplies x by the aspect ratio, so this recovers it for the trip back.
    return { t, ar: sq({ x: 1, y: 0 }).x, legs,
             vis: mean([25, 26, 27, 28].map((i) => p[i].visibility ?? 1)) };
  }, frontStill);
  settleFrontLegs(rows);              // no still means the still hook never ran

  const MIN = FRONT_FPS * 2;                         // two seconds of a usable leg
  const leftVals = rows.filter((r) => r.left != null).map((r) => r.left);
  const rightVals = rows.filter((r) => r.right != null).map((r) => r.right);
  const seen = { ...rows.stat, left: leftVals.length, right: rightVals.length,
                 legs: rows.repair,
                 visibility: +mean(rows.length ? rows.map((r) => r.vis) : [0]).toFixed(2) };
  if (leftVals.length < MIN && rightVals.length < MIN)
    return { gate: "We couldn't hold either knee in view for long enough from the front. Frame both legs from the waist down, with the light in front of you, and film again.", seen };

  /* A reading past the ceiling is a failed read, not a finding. */
  const sane = (v, max) => (Number.isFinite(v) && Math.abs(v) <= max ? v : null);

  const out = { seen, kneeTravel: {}, trim, stills: rows.stills ?? null,
                /* How each number was arrived at, in the report itself: a
                   reading rebuilt through the linkage is honest, but it is not
                   the same thing as one the model simply saw. */
                rebuilt: rows.repair?.rebuilt ?? 0,
                readings: (rows.repair?.rebuilt ?? 0) + (rows.repair?.measured ?? 0),
                track: rows.filter((r) => r.j).map((r) => ({ t: r.t, j: r.j, left: r.left, right: r.right })) };
  if (leftVals.length >= MIN) out.kneeTravel.left = sane(+amplitude(leftVals).toFixed(1), SANITY.kneeTravelDeg);
  if (rightVals.length >= MIN) out.kneeTravel.right = sane(+amplitude(rightVals).toFixed(1), SANITY.kneeTravelDeg);
  if (out.kneeTravel.left == null && out.kneeTravel.right == null)
    return { gate: "We found your knees from the front but the readings came back impossible — more side-to-side travel than a knee has. That happens when we cannot keep your two legs apart, usually because the background is dim or busy. Film with the light in front of you and nothing moving behind.", seen };
  const { left, right } = out.kneeTravel;
  if (left != null && right != null) {
    const bigger = Math.max(left, right), smaller = Math.min(left, right);
    out.asymmetry = smaller > 0.5 ? +(bigger / smaller).toFixed(2) : null;
    out.looser = left >= right ? "left" : "right";
  } else {
    out.oneLegOnly = left != null ? "left" : "right";
  }
  return out;
}

/* REAR VIEW — shoulder and pelvis rock, as the tilt of each line over the
   stroke. Rock corroborates a saddle that is too high; it does not outrank
   the side view, which is the view that measures saddle height. */
export async function analyzeRearClip(blob, trim, onProgress) {
  // From behind, the frame that matters is the most tilted one.
  const rearStill = async (video, lm, rows) => {
    const tilt = (r) => Math.abs(r.pelvis ?? r.shoulder ?? 0);
    const ranked = rows.map((_, i) => i).sort((a, b) => tilt(rows[b]) - tilt(rows[a]));
    const worst = ranked[0];
    const shot = await bestStill(video, lm, ranked.map((i) => rows[i].t), (ctx, p, w, h) => {
      const pairs = [[11, 12], [23, 24]].filter(([a, b]) => SEEN(p[a]) && SEEN(p[b]));
      if (!pairs.length) return false;
      for (const [a, b] of pairs) {
        const mid = (p[a].y + p[b].y) / 2;
        plumb(ctx, { x: p[a].x, y: mid }, { x: p[b].x, y: mid }, "#9C9A93", w, h);
        limb(ctx, [p[a], p[b]], OUT_OF_BAND, w, h);
      }
      tag(ctx, `${tilt(rows[worst]).toFixed(0)}\u00b0`, p[pairs.at(-1)[0]], OUT_OF_BAND, w, h);
      return pairs.flatMap(([a, b]) => [p[a], p[b]]);
    }, null);
    return shot.fail ? null : {
      body: { ...shot,
        caption: `The most tilted frame in this clip — ${tilt(rows[worst]).toFixed(0)}\u00b0 off level at this instant. The card above is how much the tilt changes across a whole stroke. Dashed lines are level for comparison.` },
    };
  };

  const rows = await sampleFrames(blob, trim, onProgress, 12, 40, (p, sq, t) => {
    // Shoulder line and hip line stand alone — a jersey hides hips far more
    // often than shoulders, and shoulder rock on its own is still a finding.
    const vis = (i) => (p[i].visibility ?? 1) >= CAPTURE.minJointVisibility;
    /* Order the pair by where they sit on screen, not by which one the model
       labelled "left". Seen from behind there is no face to anchor that
       decision, so the model flips the two constantly — and every flip
       inverted the sign of this angle. A shoulder line reported as rocking
       171 degrees is not a rider, it is a label swap. */
    const tilt = (a, b) => {
      const A = sq(a), B = sq(b);
      const [l, r] = A.x <= B.x ? [A, B] : [B, A];
      return deg(Math.atan2(r.y - l.y, Math.abs(r.x - l.x) + 1e-9));
    };
    const row = { vis: mean([11, 12, 23, 24].map((i) => p[i].visibility ?? 1)) };
    const level = (v) => (Number.isFinite(v) && Math.abs(v) <= SANITY.tiltDeg ? v : null);
    // Shoulders above hips, or the model has not found a rider on a bike.
    const upright = Math.min(p[11].y, p[12].y) < Math.min(p[23].y, p[24].y);

    /* A line needs two points that are actually apart. Bent over the bars the
       rider's own back hides their hips, and the model stacks both markers in
       the middle of the torso — which drew a pair of tiny dumbbells on the
       spine and called them a shoulder line and a hip line. Shoulder width is
       the reference: hips are roughly two thirds of it on anyone. */
    const across = (a, b) => Math.abs(sq(a).x - sq(b).x);
    const shoulderW = across(p[11], p[12]);
    const hipW = across(p[23], p[24]);
    const wideEnough = shoulderW >= SANITY.minSpanOfFrame;

    if (upright && wideEnough && vis(11) && vis(12)) row.shoulder = level(tilt(p[11], p[12]));
    if (upright && wideEnough && vis(23) && vis(24) && hipW >= shoulderW * SANITY.hipOverShoulder)
      row.pelvis = level(tilt(p[23], p[24]));
    if (row.shoulder == null && row.pelvis == null) return null;
    const xy = (j) => ({ x: +j.x.toFixed(4), y: +j.y.toFixed(4) });
    row.t = t;
    row.j = {};
    if (row.shoulder != null) { row.j.lsho = xy(p[11]); row.j.rsho = xy(p[12]); }
    if (row.pelvis != null) { row.j.lhip = xy(p[23]); row.j.rhip = xy(p[24]); }
    if (!Object.keys(row.j).length) return null;
    return row;
  }, rearStill);

  const MIN = 12 * 2;
  const sh = rows.filter((r) => r.shoulder != null).map((r) => r.shoulder);
  const pv = rows.filter((r) => r.pelvis != null).map((r) => r.pelvis);
  const seen = { ...rows.stat, shoulders: sh.length, pelvis: pv.length,
                 visibility: +mean(rows.length ? rows.map((r) => r.vis) : [0]).toFixed(2) };
  if (sh.length < MIN && pv.length < MIN)
    return { gate: "We couldn't hold your shoulders or hips in view for long enough from behind. Stand the phone behind the rear wheel with light from the side, and film again.", seen };

  const sane = (v, max) => (Number.isFinite(v) && Math.abs(v) <= max ? v : null);
  const out = { seen, trim, stills: rows.stills ?? null,
                track: rows.filter((r) => r.j).map((r) => ({ t: r.t, j: r.j, shoulder: r.shoulder, pelvis: r.pelvis })) };
  if (sh.length >= MIN) out.shoulderRock = sane(+amplitude(sh).toFixed(1), SANITY.rockDeg);
  if (pv.length >= MIN) out.pelvicRock = sane(+amplitude(pv).toFixed(1), SANITY.rockDeg);
  if (out.shoulderRock == null && out.pelvicRock == null)
    return { gate: "We found you from behind but the readings came back impossible — more tilt than a body makes. From behind there is no face to say which side is which, and the two got swapped. Stand the phone square behind the wheel with the light from the side.", seen };
  return out;
}

export async function analyzeSideClip(blob, [t0, t1], onProgress, opts = {}) {
  const { history = [], heightCm = null } = opts;
  const analysisStart = performance.now();
  onProgress(3, "Loading the pose model onto your phone…");
  const lm = await getLandmarker();

  const video = offscreenVideo();
  const srcUrl = URL.createObjectURL(blob);
  video.src = srcUrl;
  const release = () => { video.src = ""; URL.revokeObjectURL(srcUrl); video.remove(); };
  await new Promise((res, rej) => { video.onloadedmetadata = res; video.onerror = () => rej(new Error("could not read the video")); })
    .catch((e) => { release(); throw e; });
  await primeVideo(video);

  const sq = squareUp((video.videoWidth || 1) / (video.videoHeight || 1));

  const FPS = 15;
  const dur = await settleDuration(video);
  const end = Math.min(t1, dur || t1, t0 + 60);           // analyze ≤60 s of the trim
  const times = [];
  for (let t = t0; t < end; t += 1 / FPS) times.push(t);

  const rows = [];
  const seenFrames = [];
  let missedSeeks = 0;
  // Signals about the footage, gathered alongside the measurements.
  const frames = { sampled: 0, seen: 0, clipped: 0, vis: [], hipSpread: [] };
  const EDGE = 0.02;                       // a joint this close to the border is cut off
  onProgress(8, "Reading your pedal strokes…");
  for (let i = 0; i < times.length; i++) {
    if (!(await seekTo(video, times[i]))) {
      if (++missedSeeks >= 5) break;     // stop rather than wait on an event that will not come
      continue;
    }
    missedSeeks = 0;
    /* NO paintedFrame() here, deliberately — see the note above sampleFrames.
       Waiting for a presented frame on every sample was tried and reverted: it
       tripled the side pass and killed the two that follow it. */
    const res = lm.detectForVideo(video, performance.now());
    const p = res.landmarks?.[0];
    frames.sampled++;
    /* Collect both legs and decide later. Nothing here may depend on which leg
       we end up measuring, because that answer needs the whole clip. */
    /* video.currentTime, not times[i]. A seek lands on the nearest decodable
       frame, which can be tens of milliseconds from where it was aimed — and
       labelling a frame with the time it was ASKED for rather than the time it
       is AT is what put the overlay a fraction of a pedal stroke away from the
       rider's leg. At 85 rpm a revolution is 0.7s, so 60ms is most of a
       thigh. */
    /* The metric pose travels with the flat one. It costs nothing — the model
       computed it either way — and it is what the knee angle is read from. */
    const w = res.worldLandmarks?.[0] ?? null;
    if (p) seenFrames.push({ t: video.currentTime, w, L: SIDES.L(p), R: SIDES.R(p), hipL: p[23], hipR: p[24] });
    onProgress(8 + (82 * i) / times.length);
  }

  const { side, flipped, by: legPickedBy } = dominantSide(seenFrames);

  for (const f of seenFrames) {
      frames.seen++;
      const raw = f[side];
      const hip = sq(raw.hip), knee = sq(raw.knee), ankle = sq(raw.ankle);
      const sho = sq(raw.sho), heel = sq(raw.heel), toe = sq(raw.toe);

      const used = [raw.hip, raw.knee, raw.ankle, raw.sho];
      frames.vis.push(mean(used.map((j) => j.visibility ?? 1)));
      if (used.some((j) => j.x < EDGE || j.x > 1 - EDGE || j.y < EDGE || j.y > 1 - EDGE)) frames.clipped++;
      // Hip separation against trunk length — near zero when truly side-on.
      const trunk = Math.hypot(sho.x - hip.x, sho.y - hip.y);
      if (trunk > 1e-3) frames.hipSpread.push(Math.abs(sq(f.hipL).x - sq(f.hipR).x) / trunk);
      // Raw (un-squared) coordinates travel with the row: drawing happens in
      // image space, so the overlay can ride the clip frame by frame.
      const xy = (j) => ({ x: +j.x.toFixed(4), y: +j.y.toFixed(4) });
      rows.push({
        t: f.t,                            // frames the model missed leave gaps; keep real time
        j: { hip: xy(raw.hip), knee: xy(raw.knee), ankle: xy(raw.ankle), sho: xy(raw.sho) },
        // How well the model saw the joints this frame's angles are built from.
        conf: mean([raw.hip, raw.knee, raw.ankle, raw.sho].map((j) => j.visibility ?? 1)),
        /* Measured in three dimensions where it can be, so the number does
           not move when the phone does. `kneeFlat` is the old picture-plane
           reading, kept beside it: the difference between the two is how much
           the camera was distorting this clip, which is worth knowing and was
           previously invisible. */
        kneeBend: kneeFromWorld(f.w, side) ?? (180 - angleAt(hip, knee, ankle)),
        kneeFlat: 180 - angleAt(hip, knee, ankle),
        fromWorld: kneeFromWorld(f.w, side) != null,
        hip: angleAt(sho, hip, knee),
        torso: deg(Math.atan2(Math.abs(sho.y - hip.y), Math.abs(sho.x - hip.x) + 1e-9)),
        toeDown: -deg(Math.atan2(heel.y - toe.y, Math.abs(toe.x - heel.x) + 1e-9)),
        ankleY: ankle.y,                   // y only — unaffected by the x correction
        /* Square-corrected horizontals, kept for the fore/aft measurement.
           These never leave this function — only the derived numbers do. */
        x: { hip: hip.x, knee: knee.x, ankle: ankle.x, sho: sho.x, heel: heel.x, toe: toe.x },
        // The foot's path is a circle, so it needs both axes in the same units.
        fy: { heel: heel.y, toe: toe.y },
        femur: Math.hypot(knee.x - hip.x, knee.y - hip.y),
      });
  }

  const capture = gradeCapture(frames);
  // Rule 4: a failed read is the whole story — no numbers travel with it.
  if (capture.grade === "F") { release(); return { gate: capture.reason, capture }; }
  if (rows.length < FPS * 5) { release(); return { gate: "We couldn't see you clearly for long enough. Check the framing — whole bike and rider, decent light — and film again.", capture }; }

  /* The reported knee angle comes from a dozen frames, not from all of them.
     Those few are worth a slower, more accurate model — it is the cheapest
     accuracy there is, because the cost scales with strokes rather than with
     clip length. Everything here is best-effort: a refinement that fails
     leaves the sweep's own numbers standing. */
  /* One reading of one frame with the fine model. */
  function readFrame(p, t, w = null) {
    const raw = pickSide(p, side);
    const hip = sq(raw.hip), knee = sq(raw.knee), ankle = sq(raw.ankle);
    const sho = sq(raw.sho), heel = sq(raw.heel), toe = sq(raw.toe);
    const xy = (j) => ({ x: +j.x.toFixed(4), y: +j.y.toFixed(4) });
    return {
      t,
      j: { hip: xy(raw.hip), knee: xy(raw.knee), ankle: xy(raw.ankle), sho: xy(raw.sho) },
      conf: mean([raw.hip, raw.knee, raw.ankle, raw.sho].map((j) => j.visibility ?? 1)),
      kneeBend: kneeFromWorld(w, side) ?? (180 - angleAt(hip, knee, ankle)),
      kneeFlat: 180 - angleAt(hip, knee, ankle),
      fromWorld: kneeFromWorld(w, side) != null,
      hip: angleAt(sho, hip, knee),
      torso: deg(Math.atan2(Math.abs(sho.y - hip.y), Math.abs(sho.x - hip.x) + 1e-9)),
      toeDown: -deg(Math.atan2(heel.y - toe.y, Math.abs(toe.x - heel.x) + 1e-9)),
      ankleY: ankle.y,
      x: { hip: hip.x, knee: knee.x, ankle: ankle.x, sho: sho.x, heel: heel.x, toe: toe.x },
      fy: { heel: heel.y, toe: toe.y },
      femur: Math.hypot(knee.x - hip.x, knee.y - hip.y),
      refined: true,
    };
  }

  async function loadFine() {
    const t0 = performance.now();
    try {
      /* 30 MB over a bad connection could otherwise leave the rider watching a
         progress bar forever. Time it out and keep the sweep's numbers — less
         precise beats never finishing. */
      const fine = await Promise.race([
        getFineLandmarker(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("fine model timed out")), FINE_MODEL_TIMEOUT_MS)),
      ]);
      timing.modelLoadMs = Math.round(performance.now() - t0);
      return fine;
    } catch (e) { timing.fineModelError = e?.message ?? "could not load"; return null; }
  }

  /* Both poses come back together. Reading the re-checked strokes flat while
     the rest of the clip was read in three dimensions would put two different
     measurements into one median — the same fault as mixing two models, which
     cost ±12.5° the last time it happened. */
  async function detectAt(fine, t) {
    if (!(await seekTo(video, t, 3000))) return null;
    await paintedFrame(video, 400);
    try {
      const r = fine.detect(video);
      const p = r.landmarks?.[0];
      return p ? { p, w: r.worldLandmarks?.[0] ?? null } : null;
    } catch { return null; }
  }

  /* Re-read the strokes, and look either side of each one for where the ankle
     actually reaches its extreme. `wantLow` is the bottom of the stroke, where
     the ankle sits lowest on screen — y grows downward, so that is a maximum. */
  async function refine(idxs, wantLow, from, to, budget = REFINE_STROKES, steps = SUBFRAME.steps) {
    const pick = spread(idxs, budget);
    const fine = await loadFine();
    if (!fine) return 0;
    if (!(await seekTo(video, 0, 6000))) return 0;

    const t1 = performance.now();
    const step = 1 / (FPS * SUBFRAME.divisor);
    let done = 0, reads = 0;
    for (const [n, i] of pick.entries()) {
      let best = null, same = null;
      for (let k = -steps; k <= steps; k++) {
        const t = rows[i].t + k * step;
        if (t < t0 || t > end) continue;
        const got = await detectAt(fine, t);
        reads++;
        if (!got) continue;
        const m = readFrame(got.p, t, got.w);
        if (k === 0) same = m;
        const better = !best || (wantLow ? m.ankleY > best.ankleY : m.ankleY < best.ankleY);
        if (better) best = m;
      }
      if (best) {
        /* The sweep's reading of this exact frame, kept beside the accurate
           one. Same frame, two models: the difference is the systematic gap
           between them on this clip, and that is what corrects the curve. */
        if (same && !rows[i].refined)
          rows[i].sweep = { kneeBend: rows[i].kneeBend, hip: rows[i].hip, toeDown: rows[i].toeDown,
                            fine: { kneeBend: same.kneeBend, hip: same.hip, toeDown: same.toeDown } };
        Object.assign(rows[i], best); done++;
      }
      onProgress(from + ((to - from) * (n + 1)) / pick.length);
    }
    timing.refineMs = (timing.refineMs ?? 0) + Math.round(performance.now() - t1);
    timing.fineReads = (timing.fineReads ?? 0) + reads;
    return done;
  }

  /* What this actually cost, in milliseconds, reported with the read. The
     whole point of moving to the heavy model was to find out what it costs on
     a real phone, and that is not answerable from a feeling. */
  const timing = { startedAt: analysisStart };

  onProgress(87, "Finding the bottom of each stroke…");
  /* From the sweep alone, before any frame is re-read by the other model. */
  const curveDiag = {};
  const curve = strokeCurve(rows, FPS, curveDiag);
  const ay = rows.map((r) => r.ankleY);
  const bdc = curve && curve.bdcFrames.length >= 5 ? curve.bdcFrames : findPeaks(ay, FPS * 0.45, 0.25);
  const tdcIdx = curve && curve.tdcFrames.length >= 5 ? curve.tdcFrames : findPeaks(ay.map((v) => -v), FPS * 0.45, 0.25);
  if (bdc.length < 5) { release(); return { gate: "We couldn't find steady pedalling in the part you selected. Move the trim to a section where you ride continuously.", capture }; }

  /* Only now is it known which frames matter, which is the whole point: the
     accurate model is spent on those and nothing else. */
  /* Both ends of the stroke get the accurate model now. The hip fold is taken
     at the top and was being read by the sweep alone, which meant one card in
     the report was measured to a different standard than the one above it. */
  onProgress(88, "Re-reading the bottom of each stroke closely\u2026");
  let refined = 0, refinedTop = 0;
  /* With a curve to carry the numbers, the accurate model's job changes. It no
     longer has to find the extreme of each stroke — the curve does that from
     every frame — but to say how far the sweep model reads from it on this
     clip. That is a same-frame comparison, so no sub-frame search, and a
     median offset settles in a dozen strokes, so fewer of them. Without a
     curve the old one-frame-per-stroke read stands and gets the full pass. */
  const fineBudget = curve ? FINE_OFFSET.strokes : REFINE_STROKES;
  const fineSteps = curve ? 0 : SUBFRAME.steps;
  /* A failure here is recorded, never swallowed. The catch used to be empty,
     and it hid a ReferenceError for a week. */
  try { refined = await refine(bdc, true, 88, 91, fineBudget, fineSteps); }
  catch (e) { timing.refineError = e?.message ?? "refine failed"; }
  if (refined && tdcIdx.length) {
    onProgress(91, "And the top of each stroke\u2026");
    try { refinedTop = await refine(tdcIdx, false, 91, 94, fineBudget, fineSteps); }
    catch (e) { timing.refineError = e?.message ?? "refine failed"; }
  }

  /* SADDLE FORE/AFT — the gap every review of these apps points at.
     At the three o'clock crank position, fitters look at where the front of
     the knee sits relative to the pedal axle. Finding that moment needs no
     crank: the ankle is furthest forward exactly when the crank is horizontal
     and forward. The axle itself is not visible to the model, so it is placed
     along the foot at AXLE_ALONG_FOOT, and the result is scaled to
     centimetres through the rider's thigh — both stated assumptions, which is
     why this reports a position and never a verdict. */
  /* The three o'clock frames are neither the top nor the bottom of the stroke,
     so nothing above has touched them. Re-read them plainly — the fore/aft
     figure moves slowly through that part of the circle, so there is nothing
     for a sub-frame search to find, but there is no reason for one card to be
     measured by the smaller model when the rest are not. */
  if (refined && !curve) {   // the curve reads fore/aft from every frame; only the one-frame path needs these
    const { three } = threeOClock(rows, FPS);
    if (three.length) {
      onProgress(94, "Re-reading the cranks-level frames\u2026");
      try { await refine(three, true, 94, 95, REFINE_STROKES, 0); }
      catch (e) { timing.refineError = e?.message ?? "refine failed"; }
    }
  }
  const foreaftPk = kneeOverAxle(rows, FPS);
  const foreaft = curve?.foreaft ?? foreaftPk;
  if (foreaft?.fromCrank != null) {
    /* The crank the foot drew is the better ruler. It is measured in this
       clip rather than assumed about this rider, and it needs no height. */
    foreaft.cm = foreaft.fromCrank;
    foreaft.sdCm = foreaft.sdCrankCm;
    foreaft.ruler = "crank";
  } else if (foreaft && heightCm > 0) {
    // Fallback: one known length turns thigh-lengths into centimetres, through
    // a population thigh proportion. Approximate, and the card says so.
    foreaft.cm = foreaft.ofFemur * FEMUR_OVER_HEIGHT * heightCm;
    foreaft.sdCm = foreaft.sd * FEMUR_OVER_HEIGHT * heightCm;
    foreaft.ruler = "height";
  }

  onProgress(92, "Averaging across strokes…");

  // Row indices skip any frame the model could not read, so measure the stroke
  // period from the frames' own timestamps instead of assuming none were lost.
  const cadencePk = 60 / mean(bdc.slice(1).map((v, i) => rows[v].t - rows[bdc[i]].t));
  const cadence = curve?.cadence ?? cadencePk;

  /* A reported angle is the MEDIAN of the strokes that were clearly seen, not
     the mean of every frame. One frame of bad landmarks used to drag the
     average, and the average is what the fix is prescribed from. */
  const stat = (idxs, key) => {
    const vals = idxs.filter((i) => rows[i].conf >= CAPTURE.minJointVisibility).map((i) => rows[i][key]);
    if (!vals.length) return null;
    return { value: median(vals), sd: sd(vals), n: vals.length, of: idxs.length };
  };

  /* Two models read a joint slightly differently. Averaging some frames from
     one and some from the other adds their disagreement to what is reported as
     the rider's own stroke-to-stroke spread — which is exactly what happened
     when refinement covered 12 of 14 strokes and left 2 behind: ±12.5°, on a
     rider who had been reading ±3°. So measure from one model or the other,
     never a mixture. */
  const measured = (idxs) => {
    const fine = idxs.filter((i) => rows[i].refined);
    return fine.length >= 5 ? fine : idxs.filter((i) => !rows[i].refined);
  };
  const bdcM = measured(bdc);
  const tdcM = measured(tdcIdx);
  const allIdx = rows.map((_, i) => i);
  /* One frame per stroke, as it was always read. Kept beside the curve so the
     stored reports say whether the two agree, ride after ride — the same
     evidence-first move as when the knee went to three dimensions. */
  const kneePk = stat(bdcM, "kneeBend");
  const kneeFlatPk = stat(bdcM, "kneeFlat");
  const toePk = stat(bdcM, "toeDown");
  const hipPk = tdcM.length ? stat(tdcM, "hip") : null;
  /* THE CURVE, CORRECTED BY THE ACCURATE MODEL. The curve is fitted to the
     sweep model's reading of every frame, so it averages that model's noise
     away — but not its bias. The accurate model read the same frames at the
     bottom and top of the stroke, and the median difference between the two
     on identical frames is that bias, measured on this clip rather than
     assumed. Applying it gives the curve's steadiness with the accurate
     model's calibration, and the correction travels with the report so the
     stored rides show its size. */
  const fineOffset = curve ? {
    knee: modelOffset(rows, bdc, "kneeBend"), toe: modelOffset(rows, bdc, "toeDown"),
    hip: modelOffset(rows, tdcIdx, "hip"),
  } : null;
  const corrected = (read, off) => (read && off ? { ...read, value: read.value + off.value, corrected: off.value } : read);
  const kneeBDC = corrected(curve?.kneeBDC, fineOffset?.knee) ?? kneePk;
  const kneeFlatBDC = curve?.kneeFlatBDC ?? kneeFlatPk;
  const toeBDC = corrected(curve?.toeBDC, fineOffset?.toe) ?? toePk;
  const hipTDC = corrected(curve?.hipTDC, fineOffset?.hip) ?? hipPk;
  const torso = stat(allIdx, "torso");
  if (!kneeBDC) { release(); return { gate: "We saw you pedalling but never clearly enough at the bottom of the stroke to measure the knee. Move the phone to saddle height, 2–3 m out to the side, and film again.", capture }; }

  const [kLo, kHi] = BANDS.kneeBendBDC;
  const kneeVerdict = verdictFor(kneeBDC, BANDS.kneeBendBDC);
  const toeVerdict = verdictFor(toeBDC, BANDS.footToeDown6);
  const k = kneeBDC.value.toFixed(0), kSd = kneeBDC.sd.toFixed(1);
  const kU = uncertainty(kneeBDC);

  /* Your earlier rides are evidence about the same rider, so they are used as
     such. `history` holds the knee read from each previous session; pooling
     them is what turns a run of close calls into an answer. */
  /* This ride, plus the earlier ones measured the same way. Home and the report
     were reading different sets and reaching different conclusions on the same
     day — one saying "saddle height holds up", the other "we can't call it". */
  const pooled = pool(comparable([{ value: kneeBDC.value, sd: kneeBDC.sd, n: kneeBDC.n, era: ERA }, ...history]));
  const pooledVerdict = verdictWith(pooled.value, pooled.u, BANDS.kneeBendBDC);
  const pv = pooled.value.toFixed(0);
  const edgeSide = pooled.value < kLo ? "below" : pooled.value > kHi ? "above" : null;

  /* Bend at the bottom is a saddle-height reading, and the direction matters:
     LESS bend than the band means the leg is straightening too far, which is a
     saddle that is too HIGH and comes down. More bend means it goes up. An
     earlier version of the settled branch had this backwards and would have
     told a rider to raise a saddle that was already too high. */
  const tooStraight = pooled.value < kLo;          // saddle high → lower it
  const saddleMove = (mm) => tooStraight
    ? `Lower the saddle ${mm}, ride a minute, film again.`
    : `Raise the saddle ${mm}, ride a minute, film again.`;

  /* What it actually does for the riding. Every fix has to answer "and what
     would that get me?" — a number and a millimetre count on their own are a
     measurement, not coaching. */
  const consequence = tooStraight
    ? "A leg that straightens too far at the bottom makes you reach for the pedal, so the hips rock side to side to follow it and the load shifts onto the back of the knee and the hamstring. Riders who bring the saddle down into that range usually notice steadier hips on long efforts and less ache behind the knee afterwards."
    : "A knee still folded at the bottom never gets through its strongest part of the push, and the load sits on the front of the knee. Riders who bring the saddle up into that range usually find the pedal stroke feels less cramped and they can hold a bigger gear at the same effort.";

  /* Rides only "agree" if they all land on the same side of the band. Reads
     spanning 28° to 39° are not a rider who sits consistently below it — they
     are a rider whose reads disagree, and saying otherwise would be the app
     inventing a consistency the data does not have. */
  const sameSide = pooled.vals.every((v) => v < kLo) || pooled.vals.every((v) => v > kHi);
  /* Not `spread`: that name is the module-level helper the refine pass calls,
     and a `const spread` in this function put it in the temporal dead zone for
     the whole body — every call to refine() threw a ReferenceError that the
     catch below swallowed, and for a week no ride was read by the accurate
     model while the report said it was. tests/shadowing.test.mjs guards it. */
  const pooledSpread = pooled.hi - pooled.lo;

  /* One fix per report, ranked: an honest statement of where the rider sits
     outranks any prescription, because a change built on a coin flip is worse
     than no change.

     THREE PARTS, AND THEY HAVE SIZES. `line` is what we found, in one
     sentence. `cue` is what to do, in one sentence. Everything else — the
     evidence, the mechanics, what it gets you — belongs in `why`, which the
     report keeps folded away behind a tap.

     This card is the first thing a rider meets after their own footage, and it
     shipped once as sixteen lines of unbroken prose. Depth is not the problem
     and never was; depth arriving all at once, before anyone has asked for it,
     is. Every measurement card on this screen already opens on a sentence and
     hides its working. The fix is the card that most needs to follow that
     pattern and was the only one that did not.

     AND THE BUTTON UNDER IT ANSWERS THE CUE. A card reading "Nothing to change
     here" sat above a button saying "I made this change", because the button
     was rendered for every fix whether or not one had been asked for. So each
     fix declares what it actually wants next: `change: true` when it prescribes
     moving something, which is the only case worth logging a date against, and
     `again: true` when what it needs is another ride. A fix that wants neither
     gets no button and the card simply ends. */
  let fix;
  if (pooled.settled && !sameSide && pooledSpread > kHi - kLo)
    fix = {
      /* This card told a rider their camera was at fault in a sentence about
         degrees, and then asked them to film again — for the ninth time. Say
         the plain thing instead: we got different answers, that is our
         problem and not theirs, and here is the one thing that helps. */
      title: "We can't call your saddle height yet",
      line: `We measured your knee on ${pooled.rides} rides and got a different answer nearly every time — ${pooled.lo.toFixed(0)}° at the lowest, ${pooled.hi.toFixed(0)}° at the highest. Nothing on your bike changed, so they cannot all be right.`,
      cue: "Film one more from the side, with the whole bike in the box on screen and your seat on the line.",
      again: true,
      why: `We would rather tell you that than pick one and sound confident. Riders sit between ${kLo}° and ${kHi}° here, and the gap between your own readings is wider than that whole range — so whichever one we picked, we would have a good chance of sending you the wrong way. Saddle height is the setting everything else in a fit is built on, which is why we would rather hold it than guess. Framing it the same way is what makes two rides comparable; the guide on the capture screen is there to make that easy.`,
    };
  else if (pooled.settled && pooledVerdict === "borderline" && edgeSide)
    fix = {
      title: tooStraight ? "You ride at the bottom edge" : "You ride at the top edge",
      line: `Across ${pooled.rides} rides your knee bends ${pv}° at the bottom — just ${edgeSide} the ${kLo}–${kHi}° riders sit in, every single time.`,
      cue: tooStraight
        ? "Two to three millimetres down would bring you inside — about a third of the width of the marks on a seatpost."
        : "Two to three millimetres up would bring you inside — about a third of the width of the marks on a seatpost.",
      change: true,
      why: `Every one of those rides landed between ${pooled.lo.toFixed(0)}° and ${pooled.hi.toFixed(0)}°. That agreement across separate days and separate camera setups is the evidence; no single ride could give it. This close to the edge the difference is small and comfort should decide it. ${consequence} If nothing aches and the power feels good where you are, this is a fine place to ride.`,
    };
  else if (pooledVerdict === "low" || pooledVerdict === "high")
    fix = {
      title: tooStraight ? "Saddle looks high" : "Saddle looks low",
      line: `Your knee ${tooStraight ? "only bends" : "stays bent"} ${pv}° at the bottom${pooled.rides > 1 ? ` across ${pooled.rides} rides` : ""}, where riders sit between ${kLo}° and ${kHi}°.`,
      cue: saddleMove("5 mm"),
      change: true,
      why: `That gap is wider than the amount we could be out by (${pooled.u.toFixed(1)}°), so it is a real difference rather than a noisy read. ${consequence}`,
    };
  else if (pooledVerdict === "borderline")
    fix = {
      title: "Too close to call — one more read",
      line: `Your knee bends ${k}° at the bottom and riders sit between ${kLo}° and ${kHi}° — too close for us to call it either way.`,
      cue: `Ride ${pooled.rides} of ${SETTLE_RIDES}. Film again in the same spot.`,
      again: true,
      why: `Over ${kneeBDC.n} strokes we can place you to about ${kU.toFixed(1)}° either way, which still reaches across the edge. Moving a saddle on a reading this close is guesswork, and guesswork on saddle height is how people end up chasing knee pain around the bike. We add your rides together and how closely they agree is what settles it — one more costs ten minutes.`,
    };
  /* SADDLE HEIGHT IS SETTLED AND GOOD FROM HERE DOWN.
     It used to stop at that news: a card headed "This ride's fix" saying
     "Nothing to change here", which is not a fix and not an insight — it is
     the most valuable slot in the report spent on a non-event. Good saddle
     height is worth knowing and it is already on the card below and on the
     home screen; the headline should move to whatever IS worth doing next.
     Ranked by how much it changes about the riding: what the foot does at the
     bottom, then how shut the hip is at the top, then cadence. */
  else if (toeBDC && toeVerdict === "high")
    fix = {
      title: "Very toe-down at the bottom",
      line: `Your foot points ${toeBDC.value.toFixed(0)}° down at the bottom of the stroke, where most riders are between ${BANDS.footToeDown6[0]}° and ${BANDS.footToeDown6[1]}°.`,
      cue: "Think about dropping your heel through the bottom of the stroke — like scraping mud off the shoe.",
      change: true,      // a change to how you ride is still worth a date
      why: "Pointing the toe hard at the bottom does the work with the calf instead of the big muscles above the knee, and the calf is a much smaller engine that tires sooner. It also reads as a saddle slightly too high, so it is worth settling alongside the number above.",
    };
  else if (toeBDC && toeVerdict === "low")
    fix = {
      title: "Your heel drops through the bottom",
      line: `Your foot sits ${toeBDC.value.toFixed(0)}° toe-down at the bottom of the stroke, where most riders are between ${BANDS.footToeDown6[0]}° and ${BANDS.footToeDown6[1]}°.`,
      cue: "Let the toe fall a little as you come through the bottom, rather than holding the heel down.",
      change: true,
      why: "A heel held down through the bottom shortens how far the ankle can give, so the leg has to reach with the hip instead and the calf never gets to add anything to the end of the push. Letting the foot roll through gives you the last part of the stroke back.",
    };
  else if (hipTDC && verdictFor(hipTDC, BANDS.hipTDC) === "low")
    fix = {
      title: "You are folded shut at the top",
      line: `At the top of each stroke your thigh closes to ${hipTDC.value.toFixed(0)}° against your torso, where fitters work to ${BANDS.hipTDC[0]}–${BANDS.hipTDC[1]}°.`,
      cue: "Try the saddle back 5 mm, or the bars up one spacer — whichever your bike makes easy.",
      change: true,
      why: "When the hip runs out of room before the pedal reaches the top, the stroke stalls there instead of carrying through: riders feel it as a catch, or as not being able to get low without the power falling away. It is bought back with saddle setback and bar height, not by pushing harder. Saddle height is settled, so this is the next thing that changes how the stroke feels.",
    };
  else if (cadence < BANDS.cadence[0] - 8 || cadence > BANDS.cadence[1] + 8)
    fix = {
      title: cadence < BANDS.cadence[0] ? "You are grinding a big gear" : "You are spinning very fast",
      line: `You pedalled at ${cadence.toFixed(0)} rpm, where experienced riders mostly settle between ${BANDS.cadence[0]} and ${BANDS.cadence[1]}.`,
      cue: cadence < BANDS.cadence[0]
        ? "Drop a gear or two and hold the same speed for a few minutes at a time."
        : "Take a gear or two and hold the same speed for a few minutes at a time.",
      change: true,
      why: cadence < BANDS.cadence[0]
        ? "Every stroke at a low cadence asks more of the leg itself, so the muscles carry the effort and tire before your breathing does. Spinning shifts some of that onto your heart and lungs, which recover between strokes and your quads do not — most riders find the last hour of a long day is where they notice it."
        : "Spinning very fast hands the effort to your heart and lungs and keeps it there. It is not wrong, but a long way above your natural cadence costs you when the breathing is what is already limiting you — on a climb, or at the end of a hard hour.",
    };
  else
    fix = {
      /* Nothing to prescribe, so the card stops calling itself a fix. */
      kicker: "Where you are",
      title: "Nothing here is holding you back",
      /* Not a list of things that were fine — the one thing about this
         rider's stroke that is most worth knowing, with what to watch for. */
      line: nugget({ knee: pooled.value, toe: toeBDC?.value, hip: hipTDC?.value, cadence }),
      cue: "Ride it. Film again in a month, or the day after anything on the bike moves.",
      why: `Knee ${k}° at the bottom${pooled.rides > 1 ? ` across ${pooled.rides} rides` : ""}, foot and hip both where fitters want them, cadence ${cadence.toFixed(0)} rpm — your leg is finishing every push with the big muscles above the knee. This is the position the rest of a fit is built on, and it is settled, which means the gains left are in things the side view cannot see: whether your knees track straight, and whether you sit level. Both need the other two angles.`,
    };

  /* The picture has to be of the stroke the number describes, so show the one
     closest to the average rather than an arbitrary or best-looking frame. */
  /* EVERY CARD GETS ITS OWN FRAME.
     A number in a box is an assertion; the same number drawn on the rider at
     the moment it was taken is evidence. One still per measurement, pulled in
     time order after a single rewind, because seeking backwards through a
     MediaRecorder file is the slow part. */
  /* THE BIKE AS THE RULER. A few frames spread through the clip, downscaled,
     and the front wheel found in each; the bike is static on a trainer so the
     median across frames is one wheel. Its long axis is 670 mm whichever bike
     it is, which gives millimetres per frame-unit with nothing assumed about
     the rider — and a second, independent check on the crank the foot drew:
     the two rulers have to agree on how long a 172.5 mm crank looks, or one of
     them is wrong. */
  onProgress(94, "Finding the wheel…");
  let wheel = null, scale = null;
  try {
    const grabs = [];
    const span = end - t0;
    for (const f of [0.2, 0.4, 0.6, 0.8]) {
      const t = t0 + f * span;
      if (!(await seekTo(video, t, 3000))) continue;
      await paintedFrame(video, 300);
      const W = 320, H = Math.round((video.videoHeight / video.videoWidth) * W);
      const c = document.createElement("canvas"); c.width = W; c.height = H;
      const g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(video, 0, 0, W, H);
      const img = g.getImageData(0, 0, W, H);
      if (!hasPicture(g, W, H)) continue;
      const found = findWheel(img);
      if (found) grabs.push({ ...found, W, H });
    }
    const w = settleWheel(grabs);
    if (w && grabs.length) {
      const { W, H } = grabs[0];
      const cal = calibrate(w);
      /* Squared frame units: x is multiplied by width/height, y runs 0..1 over
         the height, so one unit is the frame's height in pixels. */
      const mmPerUnit = cal.mmPerPx * H;
      const crankMm = curve?.spindle ? +(curve.spindle.r * mmPerUnit).toFixed(0) : null;
      wheel = {
        cx: +(w.cx / W).toFixed(4), cy: +(w.cy / H).toFixed(4),
        diameter: +((2 * w.major) / H).toFixed(4),           // in frame units
        ratio: cal.ratio, yawDeg: cal.yawDeg, coverage: +w.coverage.toFixed(2), frames: grabs.length,
      };
      scale = {
        mmPerUnit: +mmPerUnit.toFixed(1), from: "wheel",
        crankMm,
        /* 165–175 mm covers nearly every crank sold. A crank that measures
           outside that means the wheel or the spindle circle is wrong, and
           neither ruler should then be trusted for centimetres. */
        rulersAgree: crankMm != null && crankMm >= 155 && crankMm <= 185,
      };
    }
  } catch { /* a report without a wheel still reports */ }

  onProgress(95, "Pulling the frame behind each number…");

  /* Candidates, not a candidate.
     A clip holds sixty to a hundred and twenty sampled frames. Choosing the
     single most representative one and giving up if the model happened not to
     see a joint clearly in that exact frame is indefensible — the next frame
     along is a fortieth of a second away and shows the same thing. These are
     ranked best-first and tried in order until one draws. */
  const rankedBy = (idxs, key, target) =>
    [...idxs].sort((a, b) => Math.abs(rows[a][key] - target) - Math.abs(rows[b][key] - target));

  const kneeColour = pooledVerdict === "ok" ? IN_BAND : OUT_OF_BAND;
  const kneeRanked = rankedBy(bdcM, "kneeBend", kneeBDC.value);
  const kneeRow = kneeRanked[0];
  const specs = [
    {
      key: "knee", row: kneeRow, tries: kneeRanked,
      caption: `Knee ${rows[kneeRow].kneeBend.toFixed(0)}\u00b0 on this stroke. The card's ${k}\u00b0 is the middle of ${kneeBDC.n} strokes like it.${
        rows[kneeRow].fromWorld && Math.abs(rows[kneeRow].kneeBend - rows[kneeRow].kneeFlat) >= 3
          ? ` The lines are drawn flat on the video, so they look like ${rows[kneeRow].kneeFlat.toFixed(0)}\u00b0 — the difference is your phone's angle, which the measurement sees past and a flat picture cannot.`
          : ""}`,
      draw: (ctx, j, w, h) => {
        if (!SEEN(j.hip) || !SEEN(j.knee) || !SEEN(j.ankle)) return false;
        limb(ctx, [j.hip, j.knee, j.ankle], kneeColour, w, h);
        tag(ctx, `${rows[kneeRow].kneeBend.toFixed(0)}\u00b0`, j.knee, kneeColour, w, h);
        return [j.hip, j.knee, j.ankle];
      },
    },
  ];

  if (toeBDC) {
    const toeRanked = rankedBy(bdcM, "toeDown", toeBDC.value);
    const toeRow = toeRanked[0];
    const toeColour = toeVerdict === "ok" ? IN_BAND : OUT_OF_BAND;
    specs.push({
      key: "foot", row: toeRow, tries: toeRanked,
      caption: `Your foot at the bottom of this stroke, ${rows[toeRow].toeDown.toFixed(0)}\u00b0 toe-down. The dashed line is level.`,
      draw: (ctx, j, w, h) => {
        if (!SEEN(j.heel) || !SEEN(j.toe)) return false;
        // dashed = the level reference the foot is measured against
        plumb(ctx, { x: j.heel.x, y: j.heel.y }, { x: j.toe.x, y: j.heel.y }, "#9C9A93", w, h);
        limb(ctx, [j.heel, j.toe], toeColour, w, h);
        tag(ctx, `${rows[toeRow].toeDown.toFixed(0)}\u00b0`, j.toe, toeColour, w, h);
        return [j.heel, j.toe, j.knee];
      },
    });
  }

  if (hipTDC && tdcM.length) {
    const tdcRanked = rankedBy(tdcM, "hip", hipTDC.value);
    const tdcRow = tdcRanked[0];
    const hipColour = verdictFor(hipTDC, BANDS.hipTDC) === "ok" ? IN_BAND : OUT_OF_BAND;
    specs.push({
      key: "hip", row: tdcRow, tries: tdcRanked,
      caption: `The top of this stroke, where your hip is most closed — ${rows[tdcRow].hip.toFixed(0)}\u00b0 between torso and thigh.`,
      draw: (ctx, j, w, h) => {
        if (!SEEN(j.sho) || !SEEN(j.hip) || !SEEN(j.knee)) return false;
        limb(ctx, [j.sho, j.hip, j.knee], hipColour, w, h);
        tag(ctx, `${rows[tdcRow].hip.toFixed(0)}\u00b0`, j.hip, hipColour, w, h);
        return [j.sho, j.hip, j.knee];
      },
    });
  }

  {
    // Mid-stroke, where the torso is doing what it does for most of the ride.
    const torsoRanked = rankedBy(rows.map((_, i) => i), "torso", torso.value);
    const torsoRow = torsoRanked[0];
    specs.push({
      key: "torso", row: torsoRow, tries: torsoRanked,
      caption: `Your back and hips at this moment, ${rows[torsoRow].torso.toFixed(0)}\u00b0 above horizontal. The dashed line is level.`,
      draw: (ctx, j, w, h) => {
        if (!SEEN(j.sho) || !SEEN(j.hip)) return false;
        plumb(ctx, { x: j.hip.x, y: j.hip.y }, { x: j.sho.x, y: j.hip.y }, "#9C9A93", w, h);
        limb(ctx, [j.hip, j.sho], IN_BAND, w, h);
        tag(ctx, `${rows[torsoRow].torso.toFixed(0)}\u00b0`, j.sho, IN_BAND, w, h);
        return [j.hip, j.sho];
      },
    });
  }

  if (foreaft?.at != null) {
    specs.push({
      key: "foreaft", row: foreaft.at, tries: foreaft.ranked ?? [foreaft.at],
      caption: "Cranks level. The dashed line drops straight down from your knee; the dot is where the pedal axle sits under the ball of your foot.",
      draw: (ctx, j, w, h) => {
        if (!SEEN(j.knee) || !SEEN(j.heel) || !SEEN(j.toe)) return false;
        const axle = {
          x: j.toe.x + AXLE_ALONG_FOOT * (j.heel.x - j.toe.x),
          y: j.toe.y + AXLE_ALONG_FOOT * (j.heel.y - j.toe.y),
        };
        plumb(ctx, { x: j.knee.x, y: j.knee.y }, { x: j.knee.x, y: axle.y }, "#9C9A93", w, h);
        dot(ctx, j.knee, OUT_OF_BAND, w, h);
        dot(ctx, axle, OUT_OF_BAND, w, h);
        limb(ctx, [{ x: j.knee.x, y: axle.y }, axle], OUT_OF_BAND, w, h);
        return [j.knee, axle, j.heel, j.toe];
      },
    });
  }

  let stillsFail = null;
  const shots = new Map();
  try {
    // One rewind, then forward through the frames in time order.
    if (!(await seekTo(video, 0, 6000))) stillsFail = "the clip would not rewind";
    else {
      const order = [...specs].sort((a, b) => rows[a.row].t - rows[b.row].t);
      for (let n = 0; n < order.length; n++) {
        const spec = order[n];
        const shot = await bestStill(video, lm, (spec.tries ?? [spec.row]).map((i) => rows[i].t), spec.draw, side);
        if (shot.fail) stillsFail ??= shot.fail;
        else shots.set(spec.key, { ...shot, caption: spec.caption });
        onProgress(95 + (4 * (n + 1)) / order.length);
      }
    }
  } catch (e) { stillsFail ??= e?.message || "the frame grab threw"; }

  /* The report's big player still opens on the bottom of the stroke, so the
     first thing on screen is the moment the headline is about. */
  const keyframes = specs.map((sp) => shots.get(sp.key)).filter(Boolean);

  onProgress(100);
  release();
  /* Rule 3: past 15 degrees off square, degree claims stop being claims. The
     camera becomes the fix and every verdict word comes off — the numbers stay
     visible, but they stop pretending to be judgements. */
  /* The wheel's yaw replaces the hip-separation guess where there is one. It
     is a real geometric reading rather than a proxy, coarse near square but
     unambiguous when the phone is well off. */
  if (wheel && capture.grade !== "F") {
    capture.offSquareDeg = wheel.yawDeg;
    capture.squarenessFrom = "wheel";
  }
  const provisional = capture.grade === "C";
  if (provisional) {
    fix = {
      title: "Square the camera up first",
      line: capture.reason,
      cue: "Stand the phone level with the saddle and square to the side of the bike, then film again.",
      again: true,
      why: "Angles read off an angled view are stretched, which is why we are not saying whether the numbers below are right or wrong. Filmed square, the same clip is worth acting on.",
    };
  }

  /* The clip itself, frame-aligned. Lets the report play the ride back with
     the angle moving on the rider instead of two frozen stills. Held in
     memory only — it is derived from video, so it never goes to the server. */
  const track = rows.map((r) => ({ t: +r.t.toFixed(3), j: r.j, knee: +r.kneeBend.toFixed(1) }));

  return {
    capture,
    wheel, scale,
    provisional,
    track,
    trim: [t0, t1],
    keyframes,
    strokes: bdc.length,
    cadence,
    /* Which leg every number here came from, and how many frames the model
       would have put on the other one. A high flip count on a side-on clip
       means the camera was not square. */
    foreAft: foreaft,
    leg: side === "L" ? "left" : "right",
    legFlips: flipped,
    legPickedBy,
    // How many of the measured strokes were re-read with the accurate model.
    refined: { strokes: refined, top: refinedTop, model: POSE_MODEL.fine, sweep: POSE_MODEL.sweep,
               ...timing, totalMs: Math.round(performance.now() - analysisStart) },
    stillsFail,
    /* How this clip was read, and what the camera was doing to it. The gap
       between the metric angle and the picture-plane one is the distortion
       this particular phone placement introduced — recorded per ride, because
       "is the spread the camera or is it us?" is a question that needs data
       across rides and had none. */
    howRead: {
      /* "curve": every number read off a periodic fit to the whole clip.
         "peaks": one frame per stroke, the older way, used when the clip gave
         no spindle circle to hang the crank angle on. The one-frame figures
         travel alongside either way, so the two can be compared across rides
         before anyone has to take the curve on trust. */
      method: curve ? "curve" : "peaks",
      revolutions: curve?.revolutions ?? null,
      curveFit: curve?.fit ?? null,
      // why there was no curve, and how close the pedal circle came
      curveDiag: curve ? null : curveDiag,
      // accurate-minus-sweep on identical frames; what the curve was shifted by
      fineOffset,
      peaks: { knee: kneePk ? +kneePk.value.toFixed(1) : null, kneeSd: kneePk ? +kneePk.sd.toFixed(1) : null,
               toe: toePk ? +toePk.value.toFixed(1) : null, hip: hipPk ? +hipPk.value.toFixed(1) : null,
               cadence: +cadencePk.toFixed(1), foreaft: foreaftPk ? +foreaftPk.ofFemur.toFixed(3) : null },
      space: bdcM.every((i) => rows[i].fromWorld) ? "3d"
        : bdcM.some((i) => rows[i].fromWorld) ? "mixed" : "flat",
      flat: kneeFlatBDC ? +kneeFlatBDC.value.toFixed(1) : null,
      flatSd: kneeFlatBDC ? +kneeFlatBDC.sd.toFixed(1) : null,
      gap: kneeFlatBDC ? +(kneeBDC.value - kneeFlatBDC.value).toFixed(1) : null,
    },
    kneeBendBDC: { value: +kneeBDC.value.toFixed(1), sd: +kneeBDC.sd.toFixed(1),
                   strokes: kneeBDC.n, of: kneeBDC.of, centre: "median",
                   mean: +kneeBDC.value.toFixed(1) },   // .mean kept for rows written before this
    kneeVerdict: pooledVerdict,
    kneeThisRide: kneeVerdict,
    /* What the verdict was actually decided on, so the report can show its
       working and Home can pick up the same story without recomputing it. */
    pooled: { value: +pooled.value.toFixed(1), u: +pooled.u.toFixed(2), rides: pooled.rides,
              settled: pooled.settled, lo: +pooled.lo.toFixed(1), hi: +pooled.hi.toFixed(1) },
    fix,
    /* HOW A CARD IS WRITTEN — the rule, for every card in this app.
       (tests/card-language.test.mjs holds it; js/pages/analyze.js follows it
       for the front and rear cards.)

       A card has two parts and they have different jobs.

       `means` is the face, and it is the part a rider actually reads. It has
       to do two things, in this order:

         1. Say what the body is doing at that moment. Which muscles are being
            asked to work, where the load lands, what the joint is doing in
            the circle. This is the mechanics, and it is the reason the
            measurement exists at all — a rider who understands it can judge
            our advice instead of taking it on faith.

         2. Say what changes if it moves. Not "this is out of range" — what
            the RIDER gets: power arriving from a different muscle, weight
            coming off the hands, an ache that stops, a position that can be
            held for another hour. Tangible, and in the second person.

       A card with only the first half is an anatomy lesson. A card with only
       the second is a verdict with nothing behind it. Both, or it is not
       finished. No watt claims and no injury promises: what the joint does,
       where the load goes, and what riders notice when it moves.

       `note` is the working, one tap down — the number, the usual range, how
       sure we are, and any reason to trust it less. Written the same way, for
       a rider who has never read a fit report.

       What neither may ever contain is our own vocabulary. No "band" for our
       thresholds, no "cited", no "verdict" as a thing we hand out or withhold,
       no model, landmark, confidence or geometry, and no notes to ourselves
       about what we are building next. If a sentence would only make sense to
       someone who has read this file, it does not ship — say the honest thing
       in the rider's words instead. "There is no good published range for
       this, so we will not score it" carries exactly the same information as
       "no cited band, reported without a verdict", and one of them is
       readable. */
    cards: (provisional ? stripVerdicts : (c) => c)([
      /* Two numbers, deliberately: how much the rider varies (±sd, about them)
         and how well the centre is known (±u, about the read). Showing only the
         first is what made every verdict look like a shrug. */
      /* Same word as the headline: a report that says "you ride at the bottom
         edge" up top and "Close" down here is telling two stories about one
         joint. */
      { name: "Knee at 6 o'clock", value: k + "°", shot: shots.get("knee"),
        means: "This one setting decides where your power comes from. Straighten too far and you reach for the bottom of the stroke, so the hips rock and the load slides onto the back of the knee. Stay too folded and you never get through the strongest part of the push. Between those two the leg works where it is strongest, and long rides stop aching in the same place.",
        verdict: pooled.settled && pooledVerdict === "borderline" ? "At edge" : word(pooledVerdict),
        note: `${whyNow("knee", pooled.value, BANDS.kneeBendBDC)} Riders sit between ${kLo}° and ${kHi}° at the bottom of the stroke, and where you land in that is what tells you whether the saddle is at the right height. Your own strokes varied by ${kSd}° either way, and across the ${kneeBDC.n} ${kneeBDC.n < kneeBDC.of ? `of ${kneeBDC.of} strokes we could read clearly` : "strokes we could read clearly"}, this ride comes out at ${k}°, give or take ${kU.toFixed(1)}°.${
          pooled.rides > 1 ? ` Counting your previous ${pooled.rides - 1} ride${pooled.rides > 2 ? "s" : ""} too: ${pv}°, give or take ${pooled.u.toFixed(1)}°.` : ""}` },
      ...(toeBDC ? [{ name: "Foot at 6 o'clock", shot: shots.get("foot"),
        means: "Pointing the toe hard at the bottom hands the work to your calf — a far smaller muscle than the ones above the knee, and the first to go on a long climb. A flatter foot lets the quad and glute finish the stroke instead.", value: toeBDC.value.toFixed(0) + "° toe-down", verdict: word(toeVerdict),
        note: `${whyNow("toe", toeBDC.value, BANDS.footToeDown6)} Most riders come through the bottom between ${BANDS.footToeDown6[0]}° and ${BANDS.footToeDown6[1]}° toe-down. Yours moved by ${toeBDC.sd.toFixed(1)}° either way from stroke to stroke.` }] : []),
      ...(hipTDC ? [{ name: "Hip fold at the top", shot: shots.get("hip"),
        means: "How far you are folded shut at the top of each stroke, where your thigh comes up to meet your torso. Fold too far and your hip runs out of room before the pedal reaches the top, so the stroke stalls there instead of carrying through — riders feel it as a catch, or as not being able to get low on the bars without the power falling away. It opens up through saddle setback and bar height, not by trying harder.", value: hipTDC.value.toFixed(0) + "°", verdict: word(verdictFor(hipTDC, BANDS.hipTDC)),
        note: `${whyNow("hip", hipTDC.value, BANDS.hipTDC)} Fitters work to ${BANDS.hipTDC[0]}–${BANDS.hipTDC[1]}° here. Where in that a particular rider should sit comes down to how much movement they have in the hips and lower back, which is not something we can see from the video. Yours moved by ${hipTDC.sd.toFixed(1)}° either way from stroke to stroke.` }] : []),
      /* Reported as a position, never as a verdict: knee-over-axle is where
         fitters START, not where riders should end up, and the two assumptions
         under the centimetre figure are named rather than hidden. */
      ...(foreaft ? [{
        name: "Knee over the pedal, 3 o'clock", shot: shots.get("foreaft"),
        means: "Where your knee sits over the pedal changes how the work splits between quads and glutes, and how much of your weight ends up on your hands. Further forward leans on the quads and the front of the knee; further back brings in the glutes and hamstrings and takes weight off the bars.",
        /* Centimetres when we can work them out, and the position in words
           when we cannot. "+25% of thigh" was neither: not a unit anyone
           thinks in, and a decimal place of precision on a figure we have
           already said is approximate. */
        value: foreaft.cm != null
          ? `${foreaft.cm > 0 ? "+" : ""}${foreaft.cm.toFixed(1)} cm`
          : Math.abs(foreaft.ofFemur) < 0.07 ? "Over the pedal"
          : foreaft.ofFemur > 0 ? "Ahead of the pedal" : "Behind the pedal",
        note: `${whyForeAft(foreaft.ofFemur, foreaft.cm)} A plus sign means your knee is ahead of the pedal axle with the cranks level. Fitters usually start with the two roughly stacked and then move the saddle to suit the rider, so this is a starting point rather than something to hit — we do not score it. Measured over ${foreaft.n} strokes.${
          foreaft.ruler === "crank"
            ? ` The centimetres come off your own pedals: your foot traces a circle as you ride, and that circle is the crank, which is 17 cm on almost every bike. Nothing here is assumed about your body.${
                scale?.rulersAgree ? " Your front wheel, measured separately, agrees with it." : scale ? " Your front wheel, measured separately, does not quite agree with it, so take the centimetres as rough." : ""}`
            : foreaft.cm != null
              ? " The centimetres are close rather than exact: they come from your height and from where the pedal axle normally sits under a foot, neither of which we can see in the video."
              : " Add your height on the Me screen to see this in centimetres."}`,
      }] : []),
      { name: "Cadence", value: cadence.toFixed(0) + " rpm",
        means: "Spinning faster shifts the effort off your legs and onto your heart and lungs; grinding does the opposite. Neither is wrong — but a long way from your natural cadence costs you late in a ride, when whichever system is carrying it starts to fade.", verdict: cadence >= BANDS.cadence[0] && cadence <= BANDS.cadence[1] ? "OK" : "", note: `${whyNow("cadence", cadence, BANDS.cadence)} Experienced riders mostly settle between ${BANDS.cadence[0]} and ${BANDS.cadence[1]} rpm. Below that you are pushing harder on each stroke; above it your heart and lungs are carrying more of it.` },
      { name: "Torso angle", value: torso.value.toFixed(0) + "°", shot: shots.get("torso"),
        means: "Folding lower puts less of you in the wind, and on the flat pushing air out of the way is where nearly all of your effort ends up going. But a low back asks more of your hip flexors to hold, and squeezes the room your lungs have to work in. The right answer is the lowest you can hold without shifting about, because a position you keep climbing out of is slower than a higher one you can stay in all day.", note: `${whyNow("torso", torso.value)} Measured up from horizontal, so a smaller number is a flatter back. What flattening out is actually worth to you depends on how fast you are going — most of it at speed on the flat, almost none of it grinding up a climb.` },
    ]),
  };
}

/* "Close" is a real answer: the band edge sits inside the margin of error on
   the reading, so neither side of the line has been earned yet. It is meant to
   be temporary — pooling rides is what retires it. */
/* The chip beside the number, in words that carry their own meaning. "Close"
   was ours: close to what, and is close good? "At the edge" says where the
   rider is; "In range" says they are fine; "Worth a look" says it is the one
   to read. Nobody has to learn them. */
function word(v) {
  return v === "ok" ? "In range" : v === "borderline" ? "At the edge" : v ? "Worth a look" : "";
}

// A number measured through a bad camera angle keeps its value and loses its verdict.
function stripVerdicts(cards) {
  return cards.map((c) => ({
    ...c,
    verdict: "",
    note: c.note + " The camera was not square to the bike, which stretches every angle a little, so read this as a rough figure rather than one to act on.",
  }));
}
