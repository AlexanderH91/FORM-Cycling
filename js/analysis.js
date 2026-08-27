import { BANDS } from "./config.js";

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
    let missed = 0;
    for (let t = t0, i = 0; t < end; t += 1 / fps, i++) {
      if (!(await seekTo(video, t))) {
        if (++missed >= 5) break;        // the clip has stopped giving frames
        continue;
      }
      missed = 0;
      const p = lm.detectForVideo(video, performance.now()).landmarks?.[0];
      if (p) { const row = read(p, sq, t); if (row) rows.push(row); }
      onProgress?.(i / total);
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

const amplitude = (a) => Math.max(...a) - Math.min(...a);

/* FRONT VIEW — how far each knee wanders sideways over the stroke.
   Measured per leg as the ankle→knee line's lean from vertical, so it is
   independent of how far away the phone was. */
export async function analyzeFrontClip(blob, trim, onProgress) {
  const rows = await sampleFrames(blob, trim, onProgress, 12, 40, (p, sq) => {
    const need = [23, 24, 25, 26, 27, 28];
    if (need.some((i) => (p[i].visibility ?? 1) < 0.5)) return null;
    const L = { hip: sq(p[23]), knee: sq(p[25]), ankle: sq(p[27]) };
    const R = { hip: sq(p[24]), knee: sq(p[26]), ankle: sq(p[28]) };
    // Rider faces the camera: their left is on our right, so inward flips.
    return {
      left:  fromVertical(L.knee, L.ankle, true),
      right: fromVertical(R.knee, R.ankle, false),
      ankleY: (L.ankle.y + R.ankle.y) / 2,
      hipSpan: Math.abs(L.hip.x - R.hip.x),
    };
  });
  if (rows.length < 12 * 4) return { gate: "We couldn't see both legs clearly for long enough from the front. Check the framing and the light, then film again." };

  const left = amplitude(rows.map((r) => r.left));
  const right = amplitude(rows.map((r) => r.right));
  const bigger = Math.max(left, right), smaller = Math.min(left, right);
  const ratio = smaller > 0.5 ? bigger / smaller : null;
  const looser = left >= right ? "left" : "right";
  return {
    kneeTravel: { left: +left.toFixed(1), right: +right.toFixed(1) },
    asymmetry: ratio ? +ratio.toFixed(2) : null,
    looser,
    frames: rows.length,
  };
}

/* REAR VIEW — shoulder and pelvis rock, as the tilt of each line over the
   stroke. Rock corroborates a saddle that is too high; it does not outrank
   the side view, which is the view that measures saddle height. */
export async function analyzeRearClip(blob, trim, onProgress) {
  const rows = await sampleFrames(blob, trim, onProgress, 12, 40, (p, sq) => {
    const need = [11, 12, 23, 24, 27, 28];
    if (need.some((i) => (p[i].visibility ?? 1) < 0.5)) return null;
    const tilt = (a, b) => deg(Math.atan2(sq(b).y - sq(a).y, Math.abs(sq(b).x - sq(a).x) + 1e-9));
    return {
      shoulder: tilt(p[11], p[12]),
      pelvis: tilt(p[23], p[24]),
      ankleY: (sq(p[27]).y + sq(p[28]).y) / 2,
    };
  });
  if (rows.length < 12 * 4) return { gate: "We couldn't see your shoulders and hips clearly for long enough from behind. Light from the side — never a window straight behind you — then film again." };

  return {
    shoulderRock: +amplitude(rows.map((r) => r.shoulder)).toFixed(1),
    pelvicRock: +amplitude(rows.map((r) => r.pelvis)).toFixed(1),
    frames: rows.length,
  };
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
  onProgress(8, "Reading your pedal strokes…");
  for (let i = 0; i < times.length; i++) {
    if (!(await seekTo(video, times[i]))) {
      if (++missedSeeks >= 5) break;     // stop rather than wait on an event that will not come
      continue;
    }
    missedSeeks = 0;
    const res = lm.detectForVideo(video, performance.now());
    const p = res.landmarks?.[0];
    if (p) {
      const raw = pickSide(p);
      const hip = sq(raw.hip), knee = sq(raw.knee), ankle = sq(raw.ankle);
      const sho = sq(raw.sho), heel = sq(raw.heel), toe = sq(raw.toe);
      rows.push({
        t: times[i],                       // frames the model missed leave gaps; keep real time
        kneeBend: 180 - angleAt(hip, knee, ankle),
        hip: angleAt(sho, hip, knee),
        torso: deg(Math.atan2(Math.abs(sho.y - hip.y), Math.abs(sho.x - hip.x) + 1e-9)),
        toeDown: -deg(Math.atan2(heel.y - toe.y, Math.abs(toe.x - heel.x) + 1e-9)),
        ankleY: ankle.y,                   // y only — unaffected by the x correction
      });
    }
    onProgress(8 + (82 * i) / times.length);
  }
  if (rows.length < FPS * 5) { release(); return { gate: "We couldn't see you clearly for long enough. Check the framing — whole bike and rider, decent light — and film again." }; }

  onProgress(92, "Averaging across strokes…");
  const ay = rows.map((r) => r.ankleY);
  const bdc = findPeaks(ay, FPS * 0.45, 0.25);
  const tdcIdx = findPeaks(ay.map((v) => -v), FPS * 0.45, 0.25);
  if (bdc.length < 5) { release(); return { gate: "We couldn't find steady pedaling in the part you selected. Move the trim to a section where you ride continuously." }; }

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
  return {
    keyframes,
    strokes: bdc.length,
    cadence,
    kneeBendBDC: { mean: +kneeBDC.mean.toFixed(1), sd: +kneeBDC.sd.toFixed(1) },
    fix,
    cards: [
      { name: "Knee at 6 o'clock", value: kneeBDC.mean.toFixed(0) + "°", verdict: kneeVerdict === "ok" ? "OK" : "Watch", note: `Band ${kLo}–${kHi}° while riding — this is the saddle-height check. ±${kneeBDC.sd.toFixed(1)}° across ${bdc.length} strokes.` },
      { name: "Foot at 6 o'clock", value: toeBDC.toFixed(0) + "° toe-down", verdict: toeBDC >= BANDS.footToeDown6[0] && toeBDC <= BANDS.footToeDown6[1] ? "OK" : "Watch", note: `Band ${BANDS.footToeDown6[0]}–${BANDS.footToeDown6[1]}° toe-down at the bottom.` },
      ...(hipTDC ? [{ name: "Hip fold at the top", value: hipTDC.toFixed(0) + "°", verdict: hipTDC >= BANDS.hipTDC[0] && hipTDC <= BANDS.hipTDC[1] ? "OK" : "Watch", note: `Fitting window ${BANDS.hipTDC[0]}–${BANDS.hipTDC[1]}° depending on flexibility.` }] : []),
      { name: "Cadence", value: cadence.toFixed(0) + " rpm", verdict: cadence >= BANDS.cadence[0] && cadence <= BANDS.cadence[1] ? "OK" : "", note: `Research sweet spot ${BANDS.cadence[0]}–${BANDS.cadence[1]} rpm for experienced riders.` },
      { name: "Torso angle", value: torso.toFixed(0) + "°", note: "Above horizontal. What it's worth in watts depends on speed — ride-file pairing comes next." },
    ],
  };
}
