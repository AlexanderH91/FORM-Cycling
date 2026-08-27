import { BANDS, CAPTURE, ANALYSIS, NO_BAND_REASON } from "./config.js";

/* On-device side-view running analysis.
   MediaPipe Pose Landmarker (WASM) runs in the browser; the video never leaves
   the phone. Same machinery as FORM Cycling — sample frames → landmarks →
   detect the gait cycle from ankle height → per-stride medians — with the
   measurement layer replaced: strides instead of pedal strokes, and a much
   smaller set of banded claims, because running has far fewer defensible
   bands than bike fit does. */

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
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const quantile = (a, q) => {
  const s = [...a].sort((x, y) => x - y);
  if (!s.length) return 0;
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

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

/* A sampled maximum only locates a foot contact to within half a frame. At 20
   fps that is worth about 13 steps per minute near a runner's cadence — wider
   than the band the verdict is read against, so the sampling grid alone could
   decide it. Fitting a parabola through each peak and its two neighbours puts
   the contact back where the signal says it was, between samples, and brings
   the error under half a step per minute. Where a frame was dropped the
   neighbours are not evenly spaced, so that peak is left where it landed. */
function refineContacts(sig, times, peaks, fps) {
  const dt = 1 / fps;
  return peaks.map((i) => {
    if (i <= 0 || i >= sig.length - 1) return times[i];
    if (Math.abs(times[i] - times[i - 1] - dt) > dt * 0.5) return times[i];
    if (Math.abs(times[i + 1] - times[i] - dt) > dt * 0.5) return times[i];
    const den = sig[i - 1] - 2 * sig[i] + sig[i + 1];
    if (Math.abs(den) < 1e-9) return times[i];
    const d = 0.5 * (sig[i - 1] - sig[i + 1]) / den;
    return Math.abs(d) <= 0.5 ? times[i] + d * dt : times[i];
  });
}

/* Palette shared with the FORM report shell. The brand accent (volt) is NEVER
   used here: it is chrome, and a colour on the runner's own body always means a
   verdict. Green in band, ember out — the same pair FORM Golf and FORM Cycling
   draw. Chalk is for a line that carries no verdict at all, which is most of
   them in this app. */
const IN_BAND = "#34D27B", OUT_OF_BAND = "#FF9147", CHALK = "#F2F4F1";

// The camera sees one side of the runner; take whichever is more visible.
function pickSide(p) {
  const L = (p[23].visibility ?? 1) + (p[25].visibility ?? 1) + (p[27].visibility ?? 1);
  const R = (p[24].visibility ?? 1) + (p[26].visibility ?? 1) + (p[28].visibility ?? 1);
  const [hip, knee, ankle, sho, heel, toe] =
    L >= R ? [p[23], p[25], p[27], p[11], p[29], p[31]] : [p[24], p[26], p[28], p[12], p[30], p[32]];
  return { hip, knee, ankle, sho, heel, toe };
}

// Every joint in `pts` must be visible in THIS frame — the caller checks that
// before asking for a line. Solid = the runner's own body (line grammar).
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
   into an approximate yaw. It is an estimate of the CAMERA, not of the runner,
   and it only ever downgrades a report — it never invents a coaching number.

   Detection and visibility are the model's own account of whether it saw you,
   so those can refuse a read outright. */
function gradeCapture(frames) {
  const detection = frames.sampled ? frames.seen / frames.sampled : 0;
  const visibility = median(frames.vis);
  const clipped = frames.seen ? frames.clipped / frames.seen : 0;

  const ratio = median(frames.hipSpread);
  const offSquareDeg = +(deg(Math.asin(Math.min(1, ratio / CAPTURE.hipWidthOverTrunk)))).toFixed(0);

  if (detection < CAPTURE.minDetection)
    return { grade: "F", reason: "We could only find you in part of the clip. Get your whole body in frame, in decent light, and film again." };
  if (visibility < CAPTURE.minVisibility)
    return { grade: "F", reason: "Your hip, knee and ankle were never clearly visible. Move the phone to hip height, 2–3 m out to the side, and film again." };

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
        ? `The phone looks about ${offSquareDeg}° off square to the treadmill. Angles read off an angled view are stretched, so this run's numbers are provisional.`
        : "Part of you left the frame while you ran, so this run's numbers are provisional.",
  };
}

/* A MediaRecorder blob reports duration Infinity on a fresh element until its
   end has been seeked. Sampling past that point makes currentTime clamp, which
   fires no "seeked" at all — waiting on an event that never comes hangs the
   analysis with the bar frozen. */
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
   found nothing there, and a stale skeleton on a moving runner is exactly the
   "drawing without a measurement" the rules forbid. */
export function overlayAt(track, t, tol = 0.1) {
  if (!track?.length) return null;
  let lo = 0, hi = track.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (track[mid].t < t) lo = mid + 1; else hi = mid; }
  const a = track[Math.max(0, lo - 1)], b = track[lo];
  const f = Math.abs(a.t - t) <= Math.abs(b.t - t) ? a : b;
  if (Math.abs(f.t - t) > tol) return null;
  const [loB, hiB] = BANDS.trunkLean;
  return { ...f, inBand: f.lean >= loB && f.lean <= hiB };
}

/* FRONT VIEW — how far each knee swings sideways across the stride.
   Measured per leg as the ankle→knee line's lean from vertical, so it is
   independent of how far away the phone was. No band exists for it, so the
   travel itself is reported without a verdict; left-versus-right evenness IS
   judged, because it compares the runner with themselves. */
export async function analyzeFrontClip(blob, trim, onProgress) {
  const rows = await sampleFrames(blob, trim, onProgress, 15, 30, (p, sq) => {
    /* Each leg stands on its own. Requiring both at once throws the whole frame
       away whenever the far ankle passes behind the near one — which happens
       every stride — and one measured leg is still worth saying. */
    const vis = (i) => (p[i].visibility ?? 1) >= CAPTURE.minJointVisibility;
    const row = { vis: mean([25, 26, 27, 28].map((i) => p[i].visibility ?? 1)) };
    // Runner faces the camera: their left is on our right, so inward flips.
    if (vis(25) && vis(27)) row.left = fromVertical(sq(p[25]), sq(p[27]), true);
    if (vis(26) && vis(28)) row.right = fromVertical(sq(p[26]), sq(p[28]), false);
    return (row.left != null || row.right != null) ? row : null;
  });

  const MIN = 15 * 2;                          // two seconds of a usable leg
  const leftVals = rows.filter((r) => r.left != null).map((r) => r.left);
  const rightVals = rows.filter((r) => r.right != null).map((r) => r.right);
  const seen = { ...rows.stat, left: leftVals.length, right: rightVals.length,
                 visibility: +mean(rows.length ? rows.map((r) => r.vis) : [0]).toFixed(2) };
  if (leftVals.length < MIN && rightVals.length < MIN)
    return { gate: "We couldn't hold either knee in view for long enough from the front. Frame both legs from the waist down, with the light in front of you, and film again.", seen };

  const out = { seen, kneeSway: {} };
  if (leftVals.length >= MIN) out.kneeSway.left = +amplitude(leftVals).toFixed(1);
  if (rightVals.length >= MIN) out.kneeSway.right = +amplitude(rightVals).toFixed(1);
  const { left, right } = out.kneeSway;
  if (left != null && right != null) {
    const bigger = Math.max(left, right), smaller = Math.min(left, right);
    out.asymmetry = smaller > 0.5 ? +(bigger / smaller).toFixed(2) : null;
    out.looser = left >= right ? "left" : "right";
  } else {
    out.oneLegOnly = left != null ? "left" : "right";
  }
  return out;
}

/* REAR VIEW — shoulder and pelvis tilt across the stride. Reported, never
   judged: FORM measures the TOTAL side-to-side range, and the published
   thresholds for running describe peak drop on a single stance leg, which is a
   different quantity. Borrowing that band would be exactly the invented
   threshold rule 4 forbids. */
export async function analyzeRearClip(blob, trim, onProgress) {
  const rows = await sampleFrames(blob, trim, onProgress, 15, 30, (p, sq) => {
    // Shoulder line and hip line stand alone — a top hides hips far more often
    // than shoulders, and shoulder rock on its own is still a finding.
    const vis = (i) => (p[i].visibility ?? 1) >= CAPTURE.minJointVisibility;
    const tilt = (a, b) => deg(Math.atan2(sq(b).y - sq(a).y, Math.abs(sq(b).x - sq(a).x) + 1e-9));
    const row = { vis: mean([11, 12, 23, 24].map((i) => p[i].visibility ?? 1)) };
    if (vis(11) && vis(12)) row.shoulder = tilt(p[11], p[12]);
    if (vis(23) && vis(24)) row.pelvis = tilt(p[23], p[24]);
    return (row.shoulder != null || row.pelvis != null) ? row : null;
  });

  const MIN = 15 * 2;
  const sh = rows.filter((r) => r.shoulder != null).map((r) => r.shoulder);
  const pv = rows.filter((r) => r.pelvis != null).map((r) => r.pelvis);
  const seen = { ...rows.stat, shoulders: sh.length, pelvis: pv.length,
                 visibility: +mean(rows.length ? rows.map((r) => r.vis) : [0]).toFixed(2) };
  if (sh.length < MIN && pv.length < MIN)
    return { gate: "We couldn't hold your shoulders or hips in view for long enough from behind. Stand the phone behind the treadmill with light from the side, and film again.", seen };

  const out = { seen };
  if (sh.length >= MIN) out.shoulderTilt = +amplitude(sh).toFixed(1);
  if (pv.length >= MIN) out.pelvicTilt = +amplitude(pv).toFixed(1);
  return out;
}

/* SIDE VIEW — the view FORM measures.

   The gait cycle is found from the near ankle's height: it is at its lowest
   when that foot is on the belt. Those troughs are one foot's contacts, so they
   are STRIDES, not steps — cadence is quoted in steps per minute, which is
   twice the stride rate. Getting that factor wrong would put every runner
   exactly one octave out. */
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

  const FPS = ANALYSIS.fps;
  const dur = await settleDuration(video);
  const end = Math.min(t1, dur || t1, t0 + ANALYSIS.maxSeconds);
  const times = [];
  for (let t = t0; t < end; t += 1 / FPS) times.push(t);

  const rows = [];
  let missedSeeks = 0;
  const frames = { sampled: 0, seen: 0, clipped: 0, vis: [], hipSpread: [] };
  const EDGE = 0.02;                       // a joint this close to the border is cut off
  onProgress(8, "Reading your stride…");
  for (let i = 0; i < times.length; i++) {
    if (!(await seekTo(video, times[i]))) {
      if (++missedSeeks >= 5) break;     // stop rather than wait on an event that will not come
      continue;
    }
    missedSeeks = 0;
    const p = lm.detectForVideo(video, performance.now()).landmarks?.[0];
    frames.sampled++;
    if (p) {
      frames.seen++;
      const raw = pickSide(p);
      const hip = sq(raw.hip), knee = sq(raw.knee), ankle = sq(raw.ankle);
      const sho = sq(raw.sho), heel = sq(raw.heel), toe = sq(raw.toe);

      const used = [raw.hip, raw.knee, raw.ankle, raw.sho];
      frames.vis.push(mean(used.map((j) => j.visibility ?? 1)));
      if (used.some((j) => j.x < EDGE || j.x > 1 - EDGE || j.y < EDGE || j.y > 1 - EDGE)) frames.clipped++;
      const trunk = Math.hypot(sho.x - hip.x, sho.y - hip.y);
      if (trunk > 1e-3) frames.hipSpread.push(Math.abs(sq(p[23]).x - sq(p[24]).x) / trunk);

      const xy = (j) => ({ x: +j.x.toFixed(4), y: +j.y.toFixed(4) });
      rows.push({
        t: times[i],                     // frames the model missed leave gaps; keep real time
        j: { hip: xy(raw.hip), knee: xy(raw.knee), ankle: xy(raw.ankle), sho: xy(raw.sho) },
        conf: mean([raw.hip, raw.knee, raw.ankle, raw.sho].map((j) => j.visibility ?? 1)),
        kneeFlex: 180 - angleAt(hip, knee, ankle),
        /* Direction of travel is not known yet — the runner may face either way.
           Store the raw components and sign them once, after the whole clip has
           voted on which way "forward" is. */
        leanX: sho.x - hip.x, leanY: hip.y - sho.y,
        shankX: ankle.x - knee.x, shankY: ankle.y - knee.y,
        toeAhead: toe.x - heel.x,
        legLen: Math.hypot(hip.x - ankle.x, hip.y - ankle.y),
        hipY: hip.y,
        ankleY: ankle.y,                 // y only — unaffected by the x correction
      });
    }
    onProgress(8 + (78 * i) / times.length);
  }
  const capture = gradeCapture(frames);
  // Rule 4: a failed read is the whole story — no numbers travel with it.
  if (capture.grade === "F") { release(); return { gate: capture.reason, capture }; }
  if (rows.length < FPS * 5) { release(); return { gate: "We couldn't see you clearly for long enough. Check the framing — your whole body, decent light — and film again.", capture }; }

  onProgress(88, "Averaging across strides…");

  /* Which way are you running? The toes sit ahead of the heels, so the sign of
     that gap is the direction of travel. Decided once, from the whole clip,
     because a single frame's foot can be mid-swing and lie. */
  const fwd = Math.sign(median(rows.map((r) => r.toeAhead))) || 1;
  for (const r of rows) {
    r.lean = deg(Math.atan2(fwd * r.leanX, Math.max(1e-9, r.leanY)));
    r.shank = deg(Math.atan2(fwd * r.shankX, Math.max(1e-9, r.shankY)));
  }

  // The near ankle is lowest when that foot is on the belt: one contact per stride.
  const ay = rows.map((r) => r.ankleY);
  const contacts = findPeaks(ay, FPS * 0.28, 0.3);
  if (contacts.length < ANALYSIS.minStrides) {
    release();
    return { gate: "We couldn't find steady running in the part you selected. Move the trim to a stretch where you run continuously, without changing pace.", capture };
  }

  /* Row indices skip any frame the model could not read, so take the stride
     period from the frames' own timestamps rather than assuming none were lost.
     One ankle's contacts are strides; cadence is quoted in steps, so it is
     twice the stride rate. Getting that factor wrong would put every runner
     exactly one octave out. */
  const contactTimes = refineContacts(ay, rows.map((r) => r.t), contacts, FPS);
  let intervals = contactTimes.slice(1)
    .map((v, i) => v - contactTimes[i])
    .filter((s) => s > 0.2 && s < 1.6);
  const roughT = median(intervals);
  // A missed contact doubles an interval and a spurious one halves it. Neither
  // is a stride, so neither belongs in the average.
  intervals = roughT > 0 ? intervals.filter((s) => s > 0.5 * roughT && s < 1.5 * roughT) : [];
  if (intervals.length < 3) {
    release();
    return { gate: "Your stride didn't come out as a steady rhythm we could count. Trim to a stretch at one constant pace and film again if you need to.", capture };
  }

  const strideT = mean(intervals);
  const cadence = 120 / strideT;
  /* Averaging many intervals recovers the timing, but their spread still
     carries the sampling grid's own variance. Taking it back out leaves the
     runner plus whatever the landmarks add — and never goes below zero. */
  const varQuant = (1 / FPS) ** 2 / 6;
  const sdStride = Math.sqrt(Math.max(0, sd(intervals) ** 2 - varQuant));
  const cadenceSd = (120 / (strideT * strideT)) * sdStride;
  /* A verdict is a claim about your AVERAGE cadence, so what decides it is how
     firmly that average is pinned — the spread over the root of how many
     strides went into it — not the stride-to-stride spread itself. Testing
     against the raw spread would call almost every honest read "too close to
     call", because most of that spread is the camera timing your feet, not you
     running unevenly. */
  const cadenceSem = cadenceSd / Math.sqrt(intervals.length);

  /* A reported angle is the MEDIAN of the strides that were clearly seen, not
     the mean of every frame. One frame of bad landmarks drags an average, and
     the average is what the fix gets prescribed from. */
  const stat = (idxs, key) => {
    const vals = idxs.filter((i) => rows[i].conf >= CAPTURE.minJointVisibility).map((i) => rows[i][key]);
    if (!vals.length) return null;
    return { value: median(vals), sd: sd(vals), n: vals.length, of: idxs.length };
  };
  const allIdx = rows.map((_, i) => i);
  const trunk = stat(allIdx, "lean");
  const kneeAtContact = stat(contacts, "kneeFlex");
  const shankAtContact = stat(contacts, "shank");

  /* Vertical oscillation, measured against the runner's own leg. Taking a
     high percentile of hip-to-ankle distance gives the leg near full extension,
     which is a stable body-scale ruler; dividing by it makes the number
     scale-free, so it needs no tape measure and no assumed proportions. */
  const legLen = quantile(rows.map((r) => r.legLen), 0.9);
  const perStrideVO = [];
  for (let i = 1; i < contacts.length; i++) {
    const seg = rows.slice(contacts[i - 1], contacts[i]).map((r) => r.hipY);
    if (seg.length >= 4 && legLen > 1e-4) perStrideVO.push((Math.max(...seg) - Math.min(...seg)) / legLen);
  }
  const vo = perStrideVO.length >= 3
    ? { pct: +(median(perStrideVO) * 100).toFixed(1), sd: +(sd(perStrideVO) * 100).toFixed(1), strides: perStrideVO.length }
    : null;

  if (!trunk) {
    release();
    return { gate: "We saw you running but never clearly enough to measure your trunk. Move the phone to hip height, 2–3 m out to the side, and film again.", capture };
  }

  /* A verdict needs the band edge to be further away than the runner's own
     stride-to-stride variation. Inside that, the honest answer is that it is
     too close to call — not a confident prescription built on 2 degrees. */
  const verdictFor = (m, [lo, hi], uncertainty) => {
    if (!m) return null;
    const edge = Math.min(Math.abs(m.value - lo), Math.abs(m.value - hi));
    if (edge < uncertainty) return "borderline";
    return m.value < lo ? "low" : m.value > hi ? "high" : "ok";
  };

  const [cLo, cHi] = BANDS.cadenceSpm;
  /* Cadence is deliberately not symmetric. The research is about raising a low
     step rate; nothing supports calling a high one a fault, so above the window
     the number is reported and no verdict is claimed in either direction. */
  const cadEdge = Math.min(Math.abs(cadence - cLo), Math.abs(cadence - cHi));
  const cadenceVerdict =
    cadence > cHi ? "above"
    : cadEdge < cadenceSem ? "borderline"
    : cadence < cLo ? "low" : "ok";

  const [tLo, tHi] = BANDS.trunkLean;
  const trunkSem = trunk.sd / Math.sqrt(Math.max(1, contacts.length));
  const trunkVerdict = verdictFor(trunk, BANDS.trunkLean, trunkSem);

  const spm = cadence.toFixed(0), spmSd = cadenceSd.toFixed(0), spmSem = cadenceSem.toFixed(1);
  const lean = trunk.value.toFixed(0), leanSd = trunk.sd.toFixed(1);

  /* One fix per report, ranked: cadence (the one lever with trial evidence
     behind it) → trunk posture → nothing to change. A borderline reading
     outranks its own fix, because the honest next move is another read rather
     than a change to how you run. */
  let fix;
  if (cadenceVerdict === "borderline")
    fix = {
      title: "Too close to call",
      line: `You're running at ${spm} steps a minute and the window is ${cLo}–${cHi}. That is nearer the edge than this read can resolve — the average is only pinned to about ±${spmSem} spm — so calling it either way would be guesswork.`,
      cue: "Run one more clip at a steady, settled pace and film it the same way. Two reads will say which side of the line you're on.",
    };
  else if (cadenceVerdict === "low")
    fix = {
      title: "Your steps are long and slow",
      line: `You're taking ${spm} steps a minute (window ${cLo}–${cHi}, ±${spmSd} across your strides). Trials that raised step rate by 5–10% lowered the load going through the hip and knee.`,
      cue: `Aim for about ${Math.round(cadence * 1.07)} spm — same pace, quicker and shorter. A metronome or a playlist at that beat is the easiest way in.`,
    };
  else if (trunkVerdict === "borderline")
    fix = {
      title: "Too close to call",
      line: `Your trunk sits ${lean}° forward and the window is ${tLo}–${tHi}°. That is nearer the edge than this read can resolve, so neither side of the line is earned yet.`,
      cue: "Film one more run the same way. Two reads will settle which side of the line you're on.",
    };
  else if (trunkVerdict === "low")
    fix = {
      title: "You're running upright",
      line: `Your trunk is ${lean}° forward of vertical (window ${tLo}–${tHi}°, ±${leanSd}° through the clip). Running more upright puts more stress through the front of the knee.`,
      cue: "Lean from the ankles, not the waist — think of the whole body tipping very slightly forward, chest proud.",
    };
  else if (trunkVerdict === "high")
    fix = {
      title: "You're folded at the waist",
      line: `Your trunk is ${lean}° forward of vertical (window ${tLo}–${tHi}°, ±${leanSd}° through the clip). Past that the hip has to work through a closed angle.`,
      cue: "Stand taller through the chest and let the lean come from your ankles instead of your waist.",
    };
  else
    fix = {
      title: "Your form holds up — keep running",
      line: `${spm} steps a minute, trunk ${lean}° forward. The two things FORM can put a research band against are both inside it.`,
      cue: "Film again in a month, or after a change of shoes — that's when a stride usually moves.",
    };

  /* The picture has to be of the stride the number describes, so show the one
     closest to the reported value rather than an arbitrary or best-looking frame. */
  onProgress(94, "Pulling the frames we measured on…");
  const closestTo = (idxs, key, target) =>
    idxs.reduce((best, i) => (Math.abs(rows[i][key] - target) < Math.abs(rows[best][key] - target) ? i : best), idxs[0]);

  const keyframes = [];
  try {
    // Contact: the leg carries no verdict, because neither knee flexion nor
    // shank angle has a cited band. Chalk, not green or ember.
    if (kneeAtContact) {
      const cRow = closestTo(contacts, "kneeFlex", kneeAtContact.value);
      const shot = await keyframe(video, lm, rows[cRow].t, (ctx, j, w, h) => {
        if (!SEEN(j.hip) || !SEEN(j.knee) || !SEEN(j.ankle)) return false;
        limb(ctx, [j.hip, j.knee, j.ankle], CHALK, w, h);
        tag(ctx, `${rows[cRow].kneeFlex.toFixed(0)}°`, j.knee, CHALK, w, h);
      });
      if (shot) keyframes.push({
        ...shot, label: "The moment you land",
        caption: shot.drawn
          ? `Knee bent ${rows[cRow].kneeFlex.toFixed(0)}° as this foot loaded — the middle of your ${contacts.length} contacts is ${kneeAtContact.value.toFixed(0)}°. Drawn in white, not green or amber: FORM has no research band for this one, so it carries no verdict.`
          : "We couldn't see hip, knee and ankle clearly enough in this frame to draw on it.",
      });
    }

    // Trunk: this one IS banded, so it gets a verdict colour.
    const trunkRow = closestTo(allIdx, "lean", trunk.value);
    const leanOk = trunkVerdict === "ok";
    const shot = await keyframe(video, lm, rows[trunkRow].t, (ctx, j, w, h) => {
      if (!SEEN(j.sho) || !SEEN(j.hip)) return false;
      limb(ctx, [j.sho, j.hip], leanOk ? IN_BAND : OUT_OF_BAND, w, h);
      tag(ctx, `${rows[trunkRow].lean.toFixed(0)}°`, j.sho, leanOk ? IN_BAND : OUT_OF_BAND, w, h);
    });
    if (shot) keyframes.push({
      ...shot, label: "Your trunk, mid-run",
      caption: shot.drawn
        ? `Leaning ${rows[trunkRow].lean.toFixed(0)}° forward of vertical here; ${trunk.value.toFixed(0)}° is the middle of the whole clip. Window ${tLo}–${tHi}°.`
        : "We couldn't see your shoulder and hip clearly enough in this frame to draw on it.",
    });
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
      cue: "Stand the phone at hip height, straight out to the side of the treadmill, and film again — then these numbers are worth acting on.",
    };
  }

  /* The clip itself, frame-aligned. Lets the report play the run back with the
     trunk angle moving on the runner instead of two frozen stills. Held in
     memory only — it is derived from video, so it never goes to the server. */
  const track = rows.map((r) => ({
    t: +r.t.toFixed(3), j: r.j,
    lean: +r.lean.toFixed(1), kneeFlex: +r.kneeFlex.toFixed(1),
  }));

  const cards = [
    { name: "Cadence", value: spm + " spm",
      verdict: cadenceVerdict === "ok" ? "In band" : cadenceVerdict === "low" ? "Watch"
             : cadenceVerdict === "borderline" ? "Close" : "",
      note: cadenceVerdict === "above"
        ? `Above the ${cLo}–${cHi} window this app coaches into. Nothing in the research calls a high step rate a fault, so FORM reports it and claims nothing either way. ±${spmSd} spm across ${contacts.length} strides.`
        : `Steps per minute, both feet, counted from ${contacts.length} contacts of one foot. Window ${cLo}–${cHi} spm (Heiderscheit 2011; Schubert 2014) — guidance, not a universal target: cadence rises with pace and falls with height. Strides landed within ±${spmSd} spm of each other, which includes how precisely a phone can time a footfall; the average itself is pinned to about ±${spmSem} spm.` },
    { name: "Trunk lean", value: lean + "° forward",
      verdict: trunkVerdict === "ok" ? "In band" : trunkVerdict === "borderline" ? "Close" : "Watch",
      note: `Hip to shoulder, against vertical, across the whole clip. Window ${tLo}–${tHi}° (Teng & Powers 2014). ±${leanSd}° as you run.` },
  ];
  if (kneeAtContact) cards.push({
    name: "Knee when you land", value: kneeAtContact.value.toFixed(0) + "°",
    note: `${NO_BAND_REASON.kneeAtContact} ±${kneeAtContact.sd.toFixed(1)}° across ${kneeAtContact.n} contacts${kneeAtContact.n < kneeAtContact.of ? ` of ${kneeAtContact.of}` : ""}.`,
  });
  if (shankAtContact) cards.push({
    name: "Shin angle when you land",
    value: `${shankAtContact.value > 0 ? "+" : ""}${shankAtContact.value.toFixed(0)}°`,
    note: `Positive means your foot lands ahead of your knee. ${NO_BAND_REASON.shankAtContact} ±${shankAtContact.sd.toFixed(1)}° across your contacts.`,
  });
  if (vo) cards.push({
    name: "Vertical travel", value: vo.pct + "% of your leg",
    note: `How far your hips rise and fall each stride, measured against your own leg length. ${NO_BAND_REASON.verticalOscillation} ±${vo.sd}% across ${vo.strides} strides.`,
  });

  return {
    capture,
    provisional,
    track,
    trim: [t0, t1],
    keyframes,
    strides: contacts.length,
    cadence,
    cadenceSpm: { value: +cadence.toFixed(1), sd: +cadenceSd.toFixed(1),
                  sem: +cadenceSem.toFixed(2), strides: contacts.length },
    cadenceVerdict,
    trunkLean: { value: +trunk.value.toFixed(1), sd: +trunk.sd.toFixed(1), n: trunk.n, of: trunk.of },
    trunkVerdict,
    kneeAtContact: kneeAtContact && { value: +kneeAtContact.value.toFixed(1), sd: +kneeAtContact.sd.toFixed(1), n: kneeAtContact.n, of: kneeAtContact.of },
    shankAtContact: shankAtContact && { value: +shankAtContact.value.toFixed(1), sd: +shankAtContact.sd.toFixed(1), n: shankAtContact.n, of: shankAtContact.of },
    verticalOscillation: vo,
    fix,
    cards: provisional ? stripVerdicts(cards) : cards,
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
