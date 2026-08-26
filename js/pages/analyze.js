import { supa } from "../supa.js";
import { MAX_RECORD_MS } from "../config.js";
import { analyzeSideClip } from "../analysis.js";
import { go } from "../main.js";
import { appbar } from "../ui.js";

/* Capture lives on one screen. Three slots — side, front, behind — each with
   its own player and trim, all visible at once. Only the side view is measured
   in v1; the others are recorded against the session for later. Filming and
   analysis both happen on the phone; the video never leaves it. */

const VIEWS = [
  { key: "side",  title: "Side view",   need: "Required",
    hint: "Phone at saddle height, 2–3 m away, whole bike and rider in frame. This is the view we measure." },
  { key: "front", title: "Front view",  need: "Optional",
    hint: "Bar height, straight ahead, both knees visible." },
  { key: "rear",  title: "From behind", need: "Optional",
    hint: "Behind the rear wheel, light from the side — never a window straight behind you." },
];

const clock = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, "0")}`;

export function renderAnalyze(view, user) {
  drawCapture(view, user, { clips: {}, trims: {}, urls: {} });
}

function drawCapture(view, user, state) {
  view.innerHTML = `
  ${appbar("capture")}
  <h1>Film your ride</h1>
  <p>All three angles live on this screen — fill them in any order. Only the side
     view is measured today; front and behind are saved with the session and get
     their own analysis in a later update.</p>
  <div id="slots"></div>
  <div class="err" id="err"></div>
  <button class="btn" id="go" disabled></button>
  <div class="footnote">Filming happens on your phone and the video stays there · recording stops on its own after ${Math.round(MAX_RECORD_MS / 60000)} minutes</div>`;

  const err = view.querySelector("#err");
  const goBtn = view.querySelector("#go");
  let recording = null;   // one camera, one recording at a time

  const refreshGo = () => {
    const ready = state.clips.side && state.trims.side;
    goBtn.disabled = !ready || !!recording;
    goBtn.textContent = ready ? "Analyze this ride →" : "Add the side view to analyze";
  };

  const ctx = {
    err, refreshGo,
    getRec: () => recording,
    setRec: (r) => { recording = r; refreshGo(); },
  };

  const slots = view.querySelector("#slots");
  for (const v of VIEWS) slots.appendChild(buildSlot(v, state, ctx));
  refreshGo();

  goBtn.onclick = () => { if (!goBtn.disabled) runAnalysis(view, user, state); };
}

function buildSlot(v, state, ctx) {
  const card = document.createElement("div");
  card.className = "glass card slot";
  card.innerHTML = `
    <div class="row"><h3>${v.title}</h3>
      <div class="val"><em class="status">${v.need}</em></div></div>
    <p>${v.hint}</p>
    <video class="preview hidden" playsinline muted loop controls></video>
    <div class="trim hidden">
      <div class="lbl"><span>Analyze from</span><span class="t0l">0:00</span></div>
      <input class="t0" type="range" min="0" max="100" value="0">
      <div class="lbl"><span>to</span><span class="t1l">0:00</span></div>
      <input class="t1" type="range" min="0" max="100" value="100">
    </div>
    <div class="slot-actions">
      <button class="btn small ${v.key === "side" ? "" : "secondary"} rec">● Record</button>
      <button class="btn small secondary pick">Choose a video</button>
      <input type="file" accept="video/*" class="hidden file">
    </div>`;

  const q = (sel) => card.querySelector(sel);
  const prev = q("video"), trim = q(".trim"), status = q(".status");
  const recBtn = q(".rec"), pickBtn = q(".pick"), file = q(".file");

  function loadClip(blob) {
    state.clips[v.key] = blob;
    if (state.urls[v.key]) URL.revokeObjectURL(state.urls[v.key]);  // a 10-minute clip is not small
    state.urls[v.key] = URL.createObjectURL(blob);
    prev.srcObject = null;
    prev.src = state.urls[v.key];
    prev.classList.remove("hidden");
    trim.classList.remove("hidden");
    prev.onloadedmetadata = () => {
      syncTrim(prev, card, state, v.key);
      ctx.refreshGo();
    };
    recBtn.innerHTML = "● Re-record";
    recBtn.classList.add("secondary");   // the gold button moves on to Analyze
    pickBtn.textContent = "Choose another";
    ctx.refreshGo();
  }

  pickBtn.onclick = () => file.click();
  file.onchange = (e) => e.target.files[0] && loadClip(e.target.files[0]);

  recBtn.onclick = async () => {
    const cur = ctx.getRec();
    if (cur && cur.key === v.key) { cur.recorder.stop(); return; }
    if (cur) { ctx.err.textContent = "Stop the clip you're already recording first."; return; }
    ctx.err.textContent = "";
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 } }, audio: false });
      prev.classList.remove("hidden");
      prev.removeAttribute("src");
      prev.srcObject = stream; prev.muted = true; prev.play();
      const chunks = [];
      const recorder = new MediaRecorder(stream);
      let timer = null;
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        clearTimeout(timer);
        ctx.setRec(null);
        recBtn.innerHTML = "● Re-record";
        loadClip(new Blob(chunks, { type: chunks[0]?.type || "video/webm" }));
      };
      recorder.start();
      timer = setTimeout(() => recorder.state !== "inactive" && recorder.stop(), MAX_RECORD_MS);
      ctx.setRec({ key: v.key, recorder });
      recBtn.innerHTML = `<span class="rec-dot"></span>Stop`;
      status.textContent = "Recording";
    } catch (e) {
      ctx.err.textContent = "Camera unavailable — choose a video instead. (" + e.message + ")";
    }
  };

  return card;
}

function syncTrim(video, card, state, key) {
  const d = video.duration || 0;
  const t0 = card.querySelector(".t0"), t1 = card.querySelector(".t1");
  const status = card.querySelector(".status");
  const update = () => {
    let a = (+t0.value / 100) * d, b = (+t1.value / 100) * d;
    if (b - a < 5) b = Math.min(d, a + 5);           // at least 5 s
    state.trims[key] = [a, b];
    card.querySelector(".t0l").textContent = clock(a);
    card.querySelector(".t1l").textContent = clock(b);
    status.textContent = clock(b - a);
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
