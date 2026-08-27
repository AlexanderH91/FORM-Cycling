import { BANDS, CAPTURE, ANGLE_FLOOR_DEG, VERDICT_SIGMAS, SETTLE_RIDES, POSE_MODEL, REFINE_STROKES, FEMUR_OVER_HEIGHT, AXLE_ALONG_FOOT } from "./config.js";

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
  if (!cache.has(key)) cache.set(key, makeLandmarker(model, mode));
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
export function kneeOverAxle(rows, fps) {
    // Which way the bike points: on a rider reaching for the bars, the
    // shoulders are ahead of the hips.
    const lean = median(rows.map((r) => r.x.sho - r.x.hip));
    if (!Number.isFinite(lean) || Math.abs(lean) < 1e-3) return null;
    const forward = Math.sign(lean);
    const reach = rows.map((r) => forward * r.x.ankle);
    const three = findPeaks(reach, fps * 0.45, 0.25)
      .filter((i) => rows[i].conf >= CAPTURE.minJointVisibility);
    if (three.length < 3) return null;

    const offs = three.map((i) => {
      const j = rows[i].x;
      const axle = j.toe + AXLE_ALONG_FOOT * (j.heel - j.toe);
      return forward * (j.knee - axle);        // + = knee ahead of the axle
    });
    const femur = median(three.map((i) => rows[i].femur));
    if (!(femur > 1e-3)) return null;
    return {
      // in thigh-lengths, which needs no assumption about the rider at all
      ofFemur: median(offs) / femur,
      sd: sd(offs) / femur,
      n: offs.length,
    };
  }

export function dominantSide(frames) {
  const lWins = frames.filter((f) => sideVis(f.L) >= sideVis(f.R)).length;
  const side = lWins * 2 >= frames.length ? "L" : "R";
  return { side, flipped: side === "L" ? frames.length - lWins : lWins };
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
  return { value, sd: k.sd ?? 0, n: k.strokes ?? 1 };
}

export function pool(reads) {
  const clean = (reads ?? []).filter((r) => r && Number.isFinite(r.value));
  if (!clean.length) return null;
  const vals = clean.map((r) => r.value);
  const centre = median(vals);
  if (clean.length === 1)
    return { value: centre, u: uncertainty(clean[0]), rides: 1, settled: false, lo: centre, hi: centre };
  const between = sd(vals) / Math.sqrt(vals.length);
  /* Never claim to be surer than one ride's own floor divided across the rides
     — a run of rides that happen to agree closely is not proof the camera was
     in the same place each time. */
  const u = Math.max(between, ANGLE_FLOOR_DEG / Math.sqrt(vals.length));
  return {
    value: centre, u, rides: vals.length,
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
async function keyframe(video, lm, t, draw, side, maxW = 720) {
  /* The sampling pass leaves the video at the end of the clip, so grabbing a
     keyframe means a long seek backwards — and in a MediaRecorder file, which
     carries no seek index, that is far slower than the forward steps the loop
     makes. The loop's 2.5s budget silently turned every keyframe into null and
     the report lost its stills. Rewind first, then go forward to the frame,
     with a budget that suits a one-off. */
  if (!(await seekTo(video, 0, 6000))) return { fail: "the clip would not rewind" };
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
  const drawn = p ? draw(ctx, pickSide(p, side), c.width, c.height) !== false : false;
  return { src: c.toDataURL("image/jpeg", 0.82), drawn };
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

  if (detection < CAPTURE.minDetection)
    return { grade: "F", reason: "We could only find you in part of the clip. Get the whole bike and rider in frame, in decent light, and film again." };
  if (visibility < CAPTURE.minVisibility)
    return { grade: "F", reason: "Your hip, knee and ankle were never clearly visible. Move the phone to saddle height, 2–3 m away, and film again." };

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

async function sampleFrames(blob, [t0, t1], onProgress, fps, seconds, read) {
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
      if (p) { stat.posed++; const row = read(p, sq, t); if (row) { stat.kept++; rows.push(row); } }
      onProgress?.(i / total);
    }
    rows.stat = stat;
    return rows;
  } finally { release(); }
}

// Angle of a limb from vertical in the frontal plane; sign is +inward (medial).
function fromVertical(top, bottom, inwardIsPositive) {
  const dx = bottom.x - top.x, dy = bottom.y - top.y;
  const a = deg(Math.atan2(dx, Math.abs(dy) + 1e-9));
  return inwardIsPositive ? a : -a;
}

const amplitude = (a) => Math.max(...a) - Math.min(...a);

/* Which pose to draw at a given moment of playback, if any.
   Returns null when the nearest analysed frame is too far away — the model
   found nothing there, and a stale skeleton on a moving rider is exactly the
   "drawing without a measurement" the rules forbid. */
export function overlayAt(track, t, tol = 0.12) {
  if (!track?.length) return null;
  let lo = 0, hi = track.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (track[mid].t < t) lo = mid + 1; else hi = mid; }
  const a = track[Math.max(0, lo - 1)], b = track[lo];
  const f = Math.abs(a.t - t) <= Math.abs(b.t - t) ? a : b;
  if (Math.abs(f.t - t) > tol) return null;
  const [lo_, hi_] = BANDS.kneeBendBDC;
  return { ...f, inBand: f.knee >= lo_ && f.knee <= hi_ };
}

/* FRONT VIEW — how far each knee wanders sideways over the stroke.
   Measured per leg as the ankle→knee line's lean from vertical, so it is
   independent of how far away the phone was. */
export async function analyzeFrontClip(blob, trim, onProgress) {
  const rows = await sampleFrames(blob, trim, onProgress, 12, 40, (p, sq) => {
    /* Each leg stands on its own. Requiring both at once threw the whole frame
       away whenever the far ankle passed behind the cranks — which is most of
       the stroke — and one measured leg is still worth saying. */
    const vis = (i) => (p[i].visibility ?? 1) >= CAPTURE.minJointVisibility;
    const row = { vis: mean([25, 26, 27, 28].map((i) => p[i].visibility ?? 1)) };
    // Rider faces the camera: their left is on our right, so inward flips.
    if (vis(25) && vis(27)) row.left = fromVertical(sq(p[25]), sq(p[27]), true);
    if (vis(26) && vis(28)) row.right = fromVertical(sq(p[26]), sq(p[28]), false);
    return (row.left != null || row.right != null) ? row : null;
  });

  const MIN = 12 * 2;                          // two seconds of a usable leg
  const leftVals = rows.filter((r) => r.left != null).map((r) => r.left);
  const rightVals = rows.filter((r) => r.right != null).map((r) => r.right);
  const seen = { ...rows.stat, left: leftVals.length, right: rightVals.length,
                 visibility: +mean(rows.length ? rows.map((r) => r.vis) : [0]).toFixed(2) };
  if (leftVals.length < MIN && rightVals.length < MIN)
    return { gate: "We couldn't hold either knee in view for long enough from the front. Frame both legs from the waist down, with the light in front of you, and film again.", seen };

  const out = { seen, kneeTravel: {} };
  if (leftVals.length >= MIN) out.kneeTravel.left = +amplitude(leftVals).toFixed(1);
  if (rightVals.length >= MIN) out.kneeTravel.right = +amplitude(rightVals).toFixed(1);
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
  const rows = await sampleFrames(blob, trim, onProgress, 12, 40, (p, sq) => {
    // Shoulder line and hip line stand alone — a jersey hides hips far more
    // often than shoulders, and shoulder rock on its own is still a finding.
    const vis = (i) => (p[i].visibility ?? 1) >= CAPTURE.minJointVisibility;
    const tilt = (a, b) => deg(Math.atan2(sq(b).y - sq(a).y, Math.abs(sq(b).x - sq(a).x) + 1e-9));
    const row = { vis: mean([11, 12, 23, 24].map((i) => p[i].visibility ?? 1)) };
    if (vis(11) && vis(12)) row.shoulder = tilt(p[11], p[12]);
    if (vis(23) && vis(24)) row.pelvis = tilt(p[23], p[24]);
    return (row.shoulder != null || row.pelvis != null) ? row : null;
  });

  const MIN = 12 * 2;
  const sh = rows.filter((r) => r.shoulder != null).map((r) => r.shoulder);
  const pv = rows.filter((r) => r.pelvis != null).map((r) => r.pelvis);
  const seen = { ...rows.stat, shoulders: sh.length, pelvis: pv.length,
                 visibility: +mean(rows.length ? rows.map((r) => r.vis) : [0]).toFixed(2) };
  if (sh.length < MIN && pv.length < MIN)
    return { gate: "We couldn't hold your shoulders or hips in view for long enough from behind. Stand the phone behind the rear wheel with light from the side, and film again.", seen };

  const out = { seen };
  if (sh.length >= MIN) out.shoulderRock = +amplitude(sh).toFixed(1);
  if (pv.length >= MIN) out.pelvicRock = +amplitude(pv).toFixed(1);
  return out;
}

export async function analyzeSideClip(blob, [t0, t1], onProgress, opts = {}) {
  const { history = [], heightCm = null } = opts;
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
    const res = lm.detectForVideo(video, performance.now());
    const p = res.landmarks?.[0];
    frames.sampled++;
    /* Collect both legs and decide later. Nothing here may depend on which leg
       we end up measuring, because that answer needs the whole clip. */
    if (p) seenFrames.push({ t: times[i], L: SIDES.L(p), R: SIDES.R(p), hipL: p[23], hipR: p[24] });
    onProgress(8 + (82 * i) / times.length);
  }

  const { side, flipped } = dominantSide(seenFrames);

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
        kneeBend: 180 - angleAt(hip, knee, ankle),
        hip: angleAt(sho, hip, knee),
        torso: deg(Math.atan2(Math.abs(sho.y - hip.y), Math.abs(sho.x - hip.x) + 1e-9)),
        toeDown: -deg(Math.atan2(heel.y - toe.y, Math.abs(toe.x - heel.x) + 1e-9)),
        ankleY: ankle.y,                   // y only — unaffected by the x correction
        /* Square-corrected horizontals, kept for the fore/aft measurement.
           These never leave this function — only the derived numbers do. */
        x: { hip: hip.x, knee: knee.x, ankle: ankle.x, sho: sho.x, heel: heel.x, toe: toe.x },
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
  async function refine(idxs, budget = REFINE_STROKES) {
    const pick = spread(idxs, budget);
    let fine;
    try { fine = await getFineLandmarker(); } catch { return 0; }
    if (!(await seekTo(video, 0, 6000))) return 0;
    let done = 0;
    for (const i of pick) {
      if (!(await seekTo(video, rows[i].t, 3000))) continue;
      await paintedFrame(video, 400);
      let p;
      try { p = fine.detect(video).landmarks?.[0]; } catch { break; }
      if (!p) continue;
      const raw = pickSide(p, side);
      const hip = sq(raw.hip), knee = sq(raw.knee), ankle = sq(raw.ankle);
      const sho = sq(raw.sho), heel = sq(raw.heel), toe = sq(raw.toe);
      const xy = (j) => ({ x: +j.x.toFixed(4), y: +j.y.toFixed(4) });
      Object.assign(rows[i], {
        j: { hip: xy(raw.hip), knee: xy(raw.knee), ankle: xy(raw.ankle), sho: xy(raw.sho) },
        conf: mean([raw.hip, raw.knee, raw.ankle, raw.sho].map((j) => j.visibility ?? 1)),
        kneeBend: 180 - angleAt(hip, knee, ankle),
        hip: angleAt(sho, hip, knee),
        toeDown: -deg(Math.atan2(heel.y - toe.y, Math.abs(toe.x - heel.x) + 1e-9)),
        refined: true,
      });
      done++;
      onProgress(88 + (4 * done) / pick.length);
    }
    return done;
  }

  onProgress(87, "Finding the bottom of each stroke…");
  const ay = rows.map((r) => r.ankleY);
  const bdc = findPeaks(ay, FPS * 0.45, 0.25);
  const tdcIdx = findPeaks(ay.map((v) => -v), FPS * 0.45, 0.25);
  if (bdc.length < 5) { release(); return { gate: "We couldn't find steady pedaling in the part you selected. Move the trim to a section where you ride continuously.", capture }; }

  /* Only now is it known which frames matter, which is the whole point: the
     accurate model is spent on those and nothing else. */
  onProgress(88, "Re-reading those strokes closely…");
  let refined = 0;
  try { refined = await refine(bdc); } catch { /* the sweep's numbers still stand */ }

  /* SADDLE FORE/AFT — the gap every review of these apps points at.
     At the three o'clock crank position, fitters look at where the front of
     the knee sits relative to the pedal axle. Finding that moment needs no
     crank: the ankle is furthest forward exactly when the crank is horizontal
     and forward. The axle itself is not visible to the model, so it is placed
     along the foot at AXLE_ALONG_FOOT, and the result is scaled to
     centimetres through the rider's thigh — both stated assumptions, which is
     why this reports a position and never a verdict. */
  const foreaft = kneeOverAxle(rows, FPS);
  if (foreaft && heightCm > 0) {
    // One known length turns thigh-lengths into centimetres. The ratio is a
    // population average, so this is approximate and says so on the card.
    foreaft.cm = foreaft.ofFemur * FEMUR_OVER_HEIGHT * heightCm;
    foreaft.sdCm = foreaft.sd * FEMUR_OVER_HEIGHT * heightCm;
  }

  onProgress(92, "Averaging across strokes…");

  // Row indices skip any frame the model could not read, so measure the stroke
  // period from the frames' own timestamps instead of assuming none were lost.
  const cadence = 60 / mean(bdc.slice(1).map((v, i) => rows[v].t - rows[bdc[i]].t));

  /* A reported angle is the MEDIAN of the strokes that were clearly seen, not
     the mean of every frame. One frame of bad landmarks used to drag the
     average, and the average is what the fix is prescribed from. */
  const stat = (idxs, key) => {
    const vals = idxs.filter((i) => rows[i].conf >= CAPTURE.minJointVisibility).map((i) => rows[i][key]);
    if (!vals.length) return null;
    return { value: median(vals), sd: sd(vals), n: vals.length, of: idxs.length };
  };
  const allIdx = rows.map((_, i) => i);
  const kneeBDC = stat(bdc, "kneeBend");
  const toeBDC = stat(bdc, "toeDown");
  const hipTDC = tdcIdx.length ? stat(tdcIdx, "hip") : null;
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
  const pooled = pool([{ value: kneeBDC.value, sd: kneeBDC.sd, n: kneeBDC.n }, ...history]);
  const pooledVerdict = verdictWith(pooled.value, pooled.u, BANDS.kneeBendBDC);
  const pv = pooled.value.toFixed(0);
  const edgeSide = pooled.value < kLo ? "below" : pooled.value > kHi ? "above" : null;

  /* One fix per report, ranked: saddle (knee out of band) → foot far out →
     torso note. What outranks all of them is an honest statement of where the
     rider actually sits, because a prescription built on a coin flip is worse
     than no prescription. */
  let fix;
  if (pooled.settled && pooledVerdict === "borderline" && edgeSide)
    /* Settled, and settled ON the line. This is a real finding, not a failure
       to measure: the rider is consistently at the edge of the band, and the
       action that follows is correspondingly small. Saying "too close to call"
       again here would be false modesty — the reads agree. */
    fix = {
      title: edgeSide === "below" ? "You ride at the bottom edge" : "You ride at the top edge",
      line: `Across ${pooled.rides} rides your knee bends ${pv}° at the bottom, every one of them between ${pooled.lo.toFixed(0)}° and ${pooled.hi.toFixed(0)}°. The band runs ${kLo}–${kHi}°, so you sit just ${edgeSide} it — consistently. That agreement across separate days and separate camera setups is the evidence; no single ride could give it.`,
      cue: edgeSide === "below"
        ? `Raising the saddle 2–3 mm would put you inside the band. That is small enough that comfort decides: if nothing aches and the power feels good, this is a fine place to ride.`
        : `Dropping the saddle 2–3 mm would put you inside the band. That is small enough that comfort decides: if nothing aches and the power feels good, this is a fine place to ride.`,
    };
  else if (pooled.settled && pooledVerdict === "ok")
    fix = {
      title: "Saddle height holds up",
      line: `Across ${pooled.rides} rides your knee bends ${pv}° at the bottom, inside the ${kLo}–${kHi}° band every time.`,
      cue: "Nothing to change here. Film again after any change to the bike or the shoes.",
    };
  else if (pooledVerdict === "low")
    fix = {
      title: "Saddle looks high",
      line: `Your knee only bends ${pv}° at the bottom${pooled.rides > 1 ? ` across ${pooled.rides} rides` : ""} — the band runs ${kLo}–${kHi}°, and that gap is bigger than the margin of error on the read (±${pooled.u.toFixed(1)}°).`,
      cue: "Drop the saddle 5 mm, ride a minute, film again.",
    };
  else if (pooledVerdict === "high")
    fix = {
      title: "Saddle looks low",
      line: `Your knee stays bent ${pv}° at the bottom${pooled.rides > 1 ? ` across ${pooled.rides} rides` : ""} — the band runs ${kLo}–${kHi}°, and that gap is bigger than the margin of error on the read (±${pooled.u.toFixed(1)}°).`,
      cue: "Raise the saddle 5 mm, ride a minute, film again.",
    };
  else if (pooledVerdict === "borderline")
    /* Not settled yet. The cue names the ride count, because the previous
       version promised that another ride would decide it and then never
       looked at the earlier ones. */
    fix = {
      title: "Too close to call — one more read",
      line: `Your knee bends ${k}° at the bottom and the band runs ${kLo}–${kHi}°. Averaged over ${kneeBDC.n} strokes that centre is good to about ±${kU.toFixed(1)}°, which still reaches across the edge of the band.`,
      cue: `Ride ${pooled.rides} of ${SETTLE_RIDES}. Film again in the same spot — FORM pools your rides, and how closely they agree is what settles it.`,
    };
  else if (toeBDC && toeVerdict === "high" && toeBDC.value > BANDS.footToeDown6[1] + 3)
    fix = { title: "Very toe-down at the bottom", line: `Your foot points ${toeBDC.value.toFixed(0)}° down at the bottom of the stroke (band ${BANDS.footToeDown6[0]}–${BANDS.footToeDown6[1]}°).`, cue: "Think about dropping your heel through the bottom of the stroke — like scraping mud off the shoe." };
  else
    fix = { title: "Position holds up — keep riding", line: `Knee ${k}° at the bottom, cadence ${cadence.toFixed(0)} rpm — the basics are in their bands.`, cue: "Film again in a month, or after any change to the bike." };

  /* The picture has to be of the stroke the number describes, so show the one
     closest to the average rather than an arbitrary or best-looking frame. */
  onProgress(96, "Pulling the frames we measured on…");
  const closestTo = (idxs, key, target) =>
    idxs.reduce((best, i) => (Math.abs(rows[i][key] - target) < Math.abs(rows[best][key] - target) ? i : best), idxs[0]);

  const keyframes = [];
  /* When a still cannot be made, SAY so. Silently dropping the section is how
     three rounds went by with "no picture references" and no way to tell
     whether the grab failed, the frame was blank, or the code never ran. */
  let stillsFail = null;
  try {
    const bdcRow = closestTo(bdc, "kneeBend", kneeBDC.mean);
    const bdcShot = await keyframe(video, lm, rows[bdcRow].t, (ctx, j, w, h) => {
      if (!SEEN(j.hip) || !SEEN(j.knee) || !SEEN(j.ankle)) return false;
      limb(ctx, [j.hip, j.knee, j.ankle], pooledVerdict === "ok" ? IN_BAND : OUT_OF_BAND, w, h);
      tag(ctx, `${rows[bdcRow].kneeBend.toFixed(0)}\u00b0`, j.knee, pooledVerdict === "ok" ? IN_BAND : OUT_OF_BAND, w, h);
    }, side);
    if (bdcShot.fail) stillsFail = bdcShot.fail;
    else keyframes.push({
      ...bdcShot, label: "Bottom of the stroke · 6 o'clock",
      caption: bdcShot.drawn
        ? `Knee ${rows[bdcRow].kneeBend.toFixed(0)}\u00b0 on this stroke — the average across all ${bdc.length} is ${kneeBDC.mean.toFixed(0)}\u00b0.`
        : "We couldn't see hip, knee and ankle clearly enough in this frame to draw on it.",
    });

    if (hipTDC != null && tdcIdx.length) {
      const tdcRow = closestTo(tdcIdx, "hip", hipTDC);
      const hipOk = hipTDC >= BANDS.hipTDC[0] && hipTDC <= BANDS.hipTDC[1];
      const tdcShot = await keyframe(video, lm, rows[tdcRow].t, (ctx, j, w, h) => {
        if (!SEEN(j.sho) || !SEEN(j.hip) || !SEEN(j.knee)) return false;
        limb(ctx, [j.sho, j.hip, j.knee], hipOk ? IN_BAND : OUT_OF_BAND, w, h);
        tag(ctx, `${rows[tdcRow].hip.toFixed(0)}\u00b0`, j.hip, hipOk ? IN_BAND : OUT_OF_BAND, w, h);
      }, side);
      if (tdcShot.fail) stillsFail ??= tdcShot.fail;
      else keyframes.push({
        ...tdcShot, label: "Top of the stroke",
        caption: tdcShot.drawn
          ? `Hip fold ${rows[tdcRow].hip.toFixed(0)}\u00b0 on this stroke — the average is ${hipTDC.toFixed(0)}\u00b0.`
          : "We couldn't see shoulder, hip and knee clearly enough in this frame to draw on it.",
      });
    }
  } catch (e) { stillsFail ??= e?.message || "the frame grab threw"; }

  onProgress(100);
  release();
  /* Rule 3: past 15 degrees off square, degree claims stop being claims. The
     camera becomes the fix and every verdict word comes off — the numbers stay
     visible, but they stop pretending to be judgements. */
  const provisional = capture.grade === "C";
  if (provisional) {
    fix = {
      title: "Square the camera up first",
      line: capture.reason,
      cue: "Stand the phone level with the saddle, straight out to the side of the bike, and film again — then these numbers are worth acting on.",
    };
  }

  /* The clip itself, frame-aligned. Lets the report play the ride back with
     the angle moving on the rider instead of two frozen stills. Held in
     memory only — it is derived from video, so it never goes to the server. */
  const track = rows.map((r) => ({ t: +r.t.toFixed(3), j: r.j, knee: +r.kneeBend.toFixed(1) }));

  return {
    capture,
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
    // How many of the measured strokes were re-read with the accurate model.
    refined: { strokes: refined, model: POSE_MODEL.fine, sweep: POSE_MODEL.sweep },
    stillsFail,
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
    cards: (provisional ? stripVerdicts : (c) => c)([
      /* Two numbers, deliberately: how much the rider varies (±sd, about them)
         and how well the centre is known (±u, about the read). Showing only the
         first is what made every verdict look like a shrug. */
      /* Same word as the headline: a report that says "you ride at the bottom
         edge" up top and "Close" down here is telling two stories about one
         joint. */
      { name: "Knee at 6 o'clock", value: k + "°",
        verdict: pooled.settled && pooledVerdict === "borderline" ? "At edge" : word(pooledVerdict),
        note: `Band ${kLo}–${kHi}° while riding — this is the saddle-height check. You vary ±${kSd}° from stroke to stroke across ${kneeBDC.n} clearly-seen strokes${kneeBDC.n < kneeBDC.of ? ` of ${kneeBDC.of}` : ""}; averaged, that puts this ride's centre within ±${kU.toFixed(1)}°.${
          pooled.rides > 1 ? ` Pooled with your previous ${pooled.rides - 1} ride${pooled.rides > 2 ? "s" : ""}: ${pv}° ±${pooled.u.toFixed(1)}°.` : ""}` },
      ...(toeBDC ? [{ name: "Foot at 6 o'clock", value: toeBDC.value.toFixed(0) + "° toe-down", verdict: word(toeVerdict),
        note: `Band ${BANDS.footToeDown6[0]}–${BANDS.footToeDown6[1]}° toe-down at the bottom. ±${toeBDC.sd.toFixed(1)}° across your strokes.` }] : []),
      ...(hipTDC ? [{ name: "Hip fold at the top", value: hipTDC.value.toFixed(0) + "°", verdict: word(verdictFor(hipTDC, BANDS.hipTDC)),
        note: `Fitting window ${BANDS.hipTDC[0]}–${BANDS.hipTDC[1]}° depending on flexibility. ±${hipTDC.sd.toFixed(1)}° across your strokes.` }] : []),
      /* Reported as a position, never as a verdict: knee-over-axle is where
         fitters START, not where riders should end up, and the two assumptions
         under the centimetre figure are named rather than hidden. */
      ...(foreaft ? [{
        name: "Knee over the pedal, 3 o'clock",
        value: foreaft.cm != null
          ? `${foreaft.cm > 0 ? "+" : ""}${foreaft.cm.toFixed(1)} cm`
          : `${foreaft.ofFemur > 0 ? "+" : ""}${(foreaft.ofFemur * 100).toFixed(0)}% of thigh`,
        note: `Plus means your knee is ahead of the pedal axle with the cranks level. Fitters commonly start with it roughly over the axle and move from there — it is a reference position, not a target, and no verdict is given on it. Measured over ${foreaft.n} strokes.${
          foreaft.cm != null
            ? " Centimetres are approximate: scaled from your height through an average thigh proportion, and the axle is placed under the ball of your foot rather than seen."
            : " Add your height on the Me screen to see this in centimetres."}`,
      }] : []),
      { name: "Cadence", value: cadence.toFixed(0) + " rpm", verdict: cadence >= BANDS.cadence[0] && cadence <= BANDS.cadence[1] ? "OK" : "", note: `Research sweet spot ${BANDS.cadence[0]}–${BANDS.cadence[1]} rpm for experienced riders.` },
      { name: "Torso angle", value: torso.value.toFixed(0) + "°", note: "Above horizontal. What it's worth in watts depends on speed — ride-file pairing comes next." },
    ]),
  };
}

/* "Close" is a real answer: the band edge sits inside the margin of error on
   the reading, so neither side of the line has been earned yet. It is meant to
   be temporary — pooling rides is what retires it. */
function word(v) {
  return v === "ok" ? "OK" : v === "borderline" ? "Close" : v ? "Watch" : "";
}

// A number measured through a bad camera angle keeps its value and loses its verdict.
function stripVerdicts(cards) {
  return cards.map((c) => ({
    ...c,
    verdict: "",
    note: c.note + " Provisional — the camera wasn't square, so treat this as indicative.",
  }));
}
