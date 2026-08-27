import { BANDS, CAPTURE } from "./config.js";

/* On-device side-view analysis.
   MediaPipe Pose Landmarker (WASM) runs in the browser; the video never
   leaves the phone. Port of the validated Python pipeline:
   sample frames → landmarks → ankle-y cycle detection → per-stroke averages. */

const MP_WASM = new URL("../assets/mp/", import.meta.url).href;
const MP_MODEL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

let landmarkerPromise = null;
async function getLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const { FilesetResolver, PoseLandmarker } =
        await import("./vendor/tasks-vision.js");
      const fileset = await FilesetResolver.forVisionTasks(MP_WASM);
      return PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MP_MODEL },
        runningMode: "VIDEO", numPoses: 1,
      });
    })();
  }
  return landmarkerPromise;
}

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
function pickSide(p) {
  const L = (p[23].visibility ?? 1) + (p[25].visibility ?? 1) + (p[27].visibility ?? 1);
  const R = (p[24].visibility ?? 1) + (p[26].visibility ?? 1) + (p[28].visibility ?? 1);
  const [hip, knee, ankle, sho, heel, toe] =
    L >= R ? [p[23], p[25], p[27], p[11], p[29], p[31]] : [p[24], p[26], p[28], p[12], p[30], p[32]];
  return { hip, knee, ankle, sho, heel, toe };
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

/* Grab the frame a number actually came from and draw that number on it.
   `draw` returns false when the joints it needs are not visible in this exact
   frame — then the still is shown with nothing drawn rather than a guess. */
async function keyframe(video, lm, t, draw, maxW = 720) {
  if (!(await seekTo(video, t))) return null;   // no frame, no drawing
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const scale = Math.min(1, maxW / vw);
  const c = document.createElement("canvas");
  c.width = Math.round(vw * scale); c.height = Math.round(vh * scale);
  const ctx = c.getContext("2d");
  ctx.drawImage(video, 0, 0, c.width, c.height);
  const p = lm.detectForVideo(video, performance.now()).landmarks?.[0];
  const drawn = p ? draw(ctx, pickSide(p), c.width, c.height) !== false : false;
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
function seekTo(video, t) {
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
    const timer = setTimeout(() => finish(false), 2500);
    try { video.currentTime = t; } catch { finish(false); }
  });
}

async function sampleFrames(blob, [t0, t1], onProgress, fps, seconds, read) {
  const lm = await getLandmarker();
  const video = document.createElement("video");
  video.muted = true; video.playsInline = true;
  const srcUrl = URL.createObjectURL(blob);
  video.src = srcUrl;
  const release = () => { video.src = ""; URL.revokeObjectURL(srcUrl); };
  try {
    await new Promise((res, rej) => {
      video.onloadedmetadata = res;
      video.onerror = () => rej(new Error("could not read the video"));
    });
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

export async function analyzeSideClip(blob, [t0, t1], onProgress) {
  onProgress(3, "Loading the pose model onto your phone…");
  const lm = await getLandmarker();

  const video = document.createElement("video");
  video.muted = true; video.playsInline = true;
  const srcUrl = URL.createObjectURL(blob);
  video.src = srcUrl;
  const release = () => { video.src = ""; URL.revokeObjectURL(srcUrl); };
  await new Promise((res, rej) => { video.onloadedmetadata = res; video.onerror = () => rej(new Error("could not read the video")); })
    .catch((e) => { release(); throw e; });

  const sq = squareUp((video.videoWidth || 1) / (video.videoHeight || 1));

  const FPS = 15;
  const dur = await settleDuration(video);
  const end = Math.min(t1, dur || t1, t0 + 60);           // analyze ≤60 s of the trim
  const times = [];
  for (let t = t0; t < end; t += 1 / FPS) times.push(t);

  const rows = [];
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
    if (p) {
      frames.seen++;
      const raw = pickSide(p);
      const hip = sq(raw.hip), knee = sq(raw.knee), ankle = sq(raw.ankle);
      const sho = sq(raw.sho), heel = sq(raw.heel), toe = sq(raw.toe);

      const used = [raw.hip, raw.knee, raw.ankle, raw.sho];
      frames.vis.push(mean(used.map((j) => j.visibility ?? 1)));
      if (used.some((j) => j.x < EDGE || j.x > 1 - EDGE || j.y < EDGE || j.y > 1 - EDGE)) frames.clipped++;
      // Hip separation against trunk length — near zero when truly side-on.
      const trunk = Math.hypot(sho.x - hip.x, sho.y - hip.y);
      if (trunk > 1e-3) frames.hipSpread.push(Math.abs(sq(p[23]).x - sq(p[24]).x) / trunk);
      // Raw (un-squared) coordinates travel with the row: drawing happens in
      // image space, so the overlay can ride the clip frame by frame.
      const xy = (j) => ({ x: +j.x.toFixed(4), y: +j.y.toFixed(4) });
      rows.push({
        t: times[i],                       // frames the model missed leave gaps; keep real time
        j: { hip: xy(raw.hip), knee: xy(raw.knee), ankle: xy(raw.ankle), sho: xy(raw.sho) },
        kneeBend: 180 - angleAt(hip, knee, ankle),
        hip: angleAt(sho, hip, knee),
        torso: deg(Math.atan2(Math.abs(sho.y - hip.y), Math.abs(sho.x - hip.x) + 1e-9)),
        toeDown: -deg(Math.atan2(heel.y - toe.y, Math.abs(toe.x - heel.x) + 1e-9)),
        ankleY: ankle.y,                   // y only — unaffected by the x correction
      });
    }
    onProgress(8 + (82 * i) / times.length);
  }
  const capture = gradeCapture(frames);
  // Rule 4: a failed read is the whole story — no numbers travel with it.
  if (capture.grade === "F") { release(); return { gate: capture.reason, capture }; }
  if (rows.length < FPS * 5) { release(); return { gate: "We couldn't see you clearly for long enough. Check the framing — whole bike and rider, decent light — and film again.", capture }; }

  onProgress(92, "Averaging across strokes…");
  const ay = rows.map((r) => r.ankleY);
  const bdc = findPeaks(ay, FPS * 0.45, 0.25);
  const tdcIdx = findPeaks(ay.map((v) => -v), FPS * 0.45, 0.25);
  if (bdc.length < 5) { release(); return { gate: "We couldn't find steady pedaling in the part you selected. Move the trim to a section where you ride continuously.", capture }; }

  // Row indices skip any frame the model could not read, so measure the stroke
  // period from the frames' own timestamps instead of assuming none were lost.
  const cadence = 60 / mean(bdc.slice(1).map((v, i) => rows[v].t - rows[bdc[i]].t));
  const at = (idxs, key) => idxs.map((i) => rows[i][key]);
  const kneeBDC = { mean: mean(at(bdc, "kneeBend")), sd: sd(at(bdc, "kneeBend")) };
  const toeBDC = mean(at(bdc, "toeDown"));
  const hipTDC = tdcIdx.length ? mean(at(tdcIdx, "hip")) : null;
  const torso = mean(rows.map((r) => r.torso));

  const [kLo, kHi] = BANDS.kneeBendBDC;
  const kneeVerdict = kneeBDC.mean < kLo ? "low" : kneeBDC.mean > kHi ? "high" : "ok";

  // One fix per report, ranked: saddle (knee out of band) → foot far out → torso note.
  let fix;
  if (kneeVerdict === "low")
    fix = { title: "Saddle looks high", line: `Your knee only bends ${kneeBDC.mean.toFixed(0)}° at the bottom (band ${kLo}–${kHi}°).`, cue: "Drop the saddle 5 mm, ride a minute, film again." };
  else if (kneeVerdict === "high")
    fix = { title: "Saddle looks low", line: `Your knee stays bent ${kneeBDC.mean.toFixed(0)}° at the bottom (band ${kLo}–${kHi}°).`, cue: "Raise the saddle 5 mm, ride a minute, film again." };
  else if (toeBDC > BANDS.footToeDown6[1] + 3)
    fix = { title: "Very toe-down at the bottom", line: `Your foot points ${toeBDC.toFixed(0)}° down at the bottom of the stroke (band ${BANDS.footToeDown6[0]}–${BANDS.footToeDown6[1]}°).`, cue: "Think about dropping your heel through the bottom of the stroke — like scraping mud off the shoe." };
  else
    fix = { title: "Position holds up — keep riding", line: `Knee ${kneeBDC.mean.toFixed(0)}° at the bottom, cadence ${cadence.toFixed(0)} rpm — the basics are in their bands.`, cue: "Film again in a month, or after any change to the bike." };

  /* The picture has to be of the stroke the number describes, so show the one
     closest to the average rather than an arbitrary or best-looking frame. */
  onProgress(96, "Pulling the frames we measured on…");
  const closestTo = (idxs, key, target) =>
    idxs.reduce((best, i) => (Math.abs(rows[i][key] - target) < Math.abs(rows[best][key] - target) ? i : best), idxs[0]);

  const keyframes = [];
  try {
    const bdcRow = closestTo(bdc, "kneeBend", kneeBDC.mean);
    const bdcShot = await keyframe(video, lm, rows[bdcRow].t, (ctx, j, w, h) => {
      if (!SEEN(j.hip) || !SEEN(j.knee) || !SEEN(j.ankle)) return false;
      limb(ctx, [j.hip, j.knee, j.ankle], kneeVerdict === "ok" ? IN_BAND : OUT_OF_BAND, w, h);
      tag(ctx, `${rows[bdcRow].kneeBend.toFixed(0)}\u00b0`, j.knee, kneeVerdict === "ok" ? IN_BAND : OUT_OF_BAND, w, h);
    });
    if (bdcShot) keyframes.push({
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
      });
      if (tdcShot) keyframes.push({
        ...tdcShot, label: "Top of the stroke",
        caption: tdcShot.drawn
          ? `Hip fold ${rows[tdcRow].hip.toFixed(0)}\u00b0 on this stroke — the average is ${hipTDC.toFixed(0)}\u00b0.`
          : "We couldn't see shoulder, hip and knee clearly enough in this frame to draw on it.",
      });
    }
  } catch { /* a report without stills still stands; the numbers are unaffected */ }

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
    kneeBendBDC: { mean: +kneeBDC.mean.toFixed(1), sd: +kneeBDC.sd.toFixed(1) },
    fix,
    cards: (provisional ? stripVerdicts : (c) => c)([
      { name: "Knee at 6 o'clock", value: kneeBDC.mean.toFixed(0) + "°", verdict: kneeVerdict === "ok" ? "OK" : "Watch", note: `Band ${kLo}–${kHi}° while riding — this is the saddle-height check. ±${kneeBDC.sd.toFixed(1)}° across ${bdc.length} strokes.` },
      { name: "Foot at 6 o'clock", value: toeBDC.toFixed(0) + "° toe-down", verdict: toeBDC >= BANDS.footToeDown6[0] && toeBDC <= BANDS.footToeDown6[1] ? "OK" : "Watch", note: `Band ${BANDS.footToeDown6[0]}–${BANDS.footToeDown6[1]}° toe-down at the bottom.` },
      ...(hipTDC ? [{ name: "Hip fold at the top", value: hipTDC.toFixed(0) + "°", verdict: hipTDC >= BANDS.hipTDC[0] && hipTDC <= BANDS.hipTDC[1] ? "OK" : "Watch", note: `Fitting window ${BANDS.hipTDC[0]}–${BANDS.hipTDC[1]}° depending on flexibility.` }] : []),
      { name: "Cadence", value: cadence.toFixed(0) + " rpm", verdict: cadence >= BANDS.cadence[0] && cadence <= BANDS.cadence[1] ? "OK" : "", note: `Research sweet spot ${BANDS.cadence[0]}–${BANDS.cadence[1]} rpm for experienced riders.` },
      { name: "Torso angle", value: torso.toFixed(0) + "°", note: "Above horizontal. What it's worth in watts depends on speed — ride-file pairing comes next." },
    ]),
  };
}

// A number measured through a bad camera angle keeps its value and loses its verdict.
function stripVerdicts(cards) {
  return cards.map((c) => ({
    ...c,
    verdict: "",
    note: c.note + " Provisional — the camera wasn't square, so treat this as indicative.",
  }));
}
