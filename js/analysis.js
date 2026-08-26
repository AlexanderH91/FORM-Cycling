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
function angleAt(a, b, c) {
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

  const FPS = 15, span = Math.min(t1 - t0, 60);           // analyze ≤60 s of the trim
  const times = [];
  for (let t = t0; t < t0 + span; t += 1 / FPS) times.push(t);

  const rows = [];
  onProgress(8, "Reading your pedal strokes…");
  for (let i = 0; i < times.length; i++) {
    video.currentTime = times[i];
    await new Promise((res) => { video.onseeked = res; });
    const res = lm.detectForVideo(video, performance.now());
    const p = res.landmarks?.[0];
    if (p) {
      // choose camera-facing side by visibility (left 23/25/27 vs right 24/26/28)
      const L = (p[23].visibility ?? 1) + (p[25].visibility ?? 1) + (p[27].visibility ?? 1);
      const R = (p[24].visibility ?? 1) + (p[26].visibility ?? 1) + (p[28].visibility ?? 1);
      const [hip, knee, ankle, sho, heel, toe] =
        L >= R ? [p[23], p[25], p[27], p[11], p[29], p[31]] : [p[24], p[26], p[28], p[12], p[30], p[32]];
      rows.push({
        kneeBend: 180 - angleAt(hip, knee, ankle),
        hip: angleAt(sho, hip, knee),
        torso: deg(Math.atan2(Math.abs(sho.y - hip.y), Math.abs(sho.x - hip.x) + 1e-9)),
        toeDown: -deg(Math.atan2(heel.y - toe.y, Math.abs(toe.x - heel.x) + 1e-9)),
        ankleY: ankle.y,
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

  const cadence = 60 / (mean(bdc.slice(1).map((v, i) => v - bdc[i])) / FPS);
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

  onProgress(100);
  release();
  return {
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
