import { supa } from "../supa.js";
import { MAX_RECORD_MS } from "../config.js";
import { analyzeSideClip } from "../analysis.js";
import { go } from "../main.js";
import { appbar } from "../ui.js";

/* Guided capture: side → front → behind. Each step: record with the phone
   camera (max 10 min) or pick a file, then trim to the steady-pedaling part.
   v1 analyzes the SIDE view on-device; front/behind are noted as captured
   (analysis for those views ships next). Videos never leave the phone. */

const STEPS = [
  { key: "side",  title: "Side view",  hint: "Saddle height, 2–3 m away, whole bike + rider in frame. This is the view we analyze first." },
  { key: "front", title: "Front view", hint: "Bar height, straight ahead, both knees visible." },
  { key: "rear",  title: "From behind", hint: "Behind the rear wheel. Light from the side — not a window behind you." },
];

export function renderAnalyze(view, user) {
  const state = { step: 0, clips: {}, trims: {} };
  drawStep(view, user, state);
}

function drawStep(view, user, state) {
  const s = STEPS[state.step];
  view.innerHTML = `
  ${appbar(`capture ${state.step + 1}/3`)}
  <div class="steps">${STEPS.map((_, i) =>
    `<i class="${i < state.step ? "done" : ""}"></i>`).join("")}</div>
  <h1>${s.title}</h1>
  <p>${s.hint}</p>
  <video id="prev" class="preview" playsinline muted loop controls></video>
  <div id="trim" class="trim hidden">
    <div class="lbl"><span>Analyze from</span><span id="t0l">0:00</span></div>
    <input id="t0" type="range" min="0" max="100" value="0">
    <div class="lbl"><span>to</span><span id="t1l">0:00</span></div>
    <input id="t1" type="range" min="0" max="100" value="100">
  </div>
  <div style="margin-top:12px">
    <button class="btn" id="rec">● Record</button>
    <button class="btn secondary" id="pick">Choose a video</button>
    <input id="file" type="file" accept="video/*" class="hidden">
    <button class="btn hidden" id="next">Use this clip →</button>
    <button class="btn secondary ${state.step ? "" : "hidden"}" id="back">Back</button>
  </div>
  <div class="err" id="err"></div>`;

  const $ = (q) => view.querySelector(q);
  const prev = $("#prev");
  let recorder = null, recTimer = null;

  let previewUrl = null;
  function loadClip(blob) {
    state.clips[s.key] = blob;
    if (previewUrl) URL.revokeObjectURL(previewUrl);   // a 10-minute clip is not small
    previewUrl = URL.createObjectURL(blob);
    prev.src = previewUrl;
    prev.classList.remove("hidden");
    $("#trim").classList.remove("hidden");
    $("#next").classList.remove("hidden");
    prev.onloadedmetadata = () => syncTrim(prev, $, state, s.key);
  }

  // Coming back to a step you already filmed used to show an empty player, as
  // if the clip were gone. It isn't — put it back on screen.
  if (state.clips[s.key]) loadClip(state.clips[s.key]);

  $("#pick").onclick = () => $("#file").click();
  $("#file").onchange = (e) => e.target.files[0] && loadClip(e.target.files[0]);

  $("#rec").onclick = async () => {
    if (recorder) { recorder.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 } }, audio: false });
      prev.srcObject = stream; prev.muted = true; prev.play();
      const chunks = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        prev.srcObject = null;
        clearTimeout(recTimer); recorder = null;
        $("#rec").innerHTML = "● Record";
        loadClip(new Blob(chunks, { type: chunks[0]?.type || "video/webm" }));
      };
      recorder.start();
      $("#rec").innerHTML = `<span class="rec-dot"></span>Stop`;
      recTimer = setTimeout(() => recorder && recorder.stop(), MAX_RECORD_MS);
    } catch (e) {
      $("#err").textContent = "Camera unavailable — choose a video instead. (" + e.message + ")";
    }
  };

  $("#back") && ($("#back").onclick = () => { state.step--; drawStep(view, user, state); });
  $("#next").onclick = () => {
    if (state.step < STEPS.length - 1) { state.step++; drawStep(view, user, state); }
    else runAnalysis(view, user, state);
  };
}

function syncTrim(video, $, state, key) {
  const d = video.duration || 0;
  const t0 = $("#t0"), t1 = $("#t1");
  const fmt = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, "0")}`;
  const update = () => {
    let a = (+t0.value / 100) * d, b = (+t1.value / 100) * d;
    if (b - a < 5) b = Math.min(d, a + 5); // at least 5 s
    state.trims[key] = [a, b];
    $("#t0l").textContent = fmt(a); $("#t1l").textContent = fmt(b);
    video.currentTime = a;
  };
  t0.oninput = update; t1.oninput = update; update();
}

async function runAnalysis(view, user, state) {
  view.innerHTML = `
  ${appbar()}
  <h1>Analyzing…</h1>
  <p id="stage">Loading the pose model onto your phone…</p>
  <div class="progress"><i id="bar"></i></div>
  <div class="err" id="err"></div>`;
  const stage = view.querySelector("#stage"), bar = view.querySelector("#bar");
  try {
    const report = await analyzeSideClip(
      state.clips.side, state.trims.side,
      (pct, msg) => { bar.style.width = pct + "%"; if (msg) stage.textContent = msg; });
    report.viewsCaptured = Object.keys(state.clips);
    // Keyframes are frames of your video. The promise is that video never
    // leaves the phone, so they are shown here and never sent to the server.
    const { keyframes, ...stored } = report;
    const { error } = await supa.from("cycling_sessions").insert({
      user_id: user.id,
      cadence_rpm: report.cadence ?? null,
      views_captured: report.viewsCaptured,
      report: stored,
    });
    if (error) throw error;
    drawReport(view, report);
  } catch (e) {
    view.querySelector("#err").textContent = "Analysis failed: " + e.message;
    stage.textContent = "Something went wrong — your clips are still on your phone; try again.";
  }
}

function drawReport(view, r) {
  const f = r.fix;
  view.innerHTML = `
  ${appbar("new report")}
  ${r.gate ? `
    <div class="glass card"><h3>We couldn't trust this read</h3>
      <p>${r.gate}</p></div>
    <a class="btn" href="#/analyze">Re-record</a>`
  : `
    <div class="glass card" style="border-left:3px solid var(--gold)">
      <div class="sect" style="margin:0 0 6px">This ride's fix</div>
      <h2>${f.title}</h2><p>${f.line}</p>
      <p><strong>Try:</strong> ${f.cue}</p>
    </div>
    ${r.keyframes?.length ? `
      <div class="sect">What we measured on</div>
      ${r.keyframes.map((k) => `
        <figure class="keyframe glass">
          <img src="${k.src}" alt="${k.label}">
          <figcaption><span class="kf-label">${k.label}</span>${k.caption}</figcaption>
        </figure>`).join("")}` : ""}
    <div class="sect">Measured</div>
    ${r.cards.map((c) => `
      <div class="glass card"><div class="row"><h3>${c.name}</h3>
        <div class="val">${c.value} ${c.verdict ? `<em>${c.verdict}</em>` : ""}</div></div>
        <p>${c.note}</p></div>`).join("")}
    <a class="btn" href="#/home">Done</a>`}
  <div class="footnote">Analyzed on your phone across ${r.strokes ?? "–"} pedal strokes · video and these frames never leave the phone · front & behind views ship in the next update</div>`;
}
