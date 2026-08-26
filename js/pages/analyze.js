import { supa } from "../supa.js";
import { MAX_RECORD_MS } from "../config.js";
import { analyzeSideClip, analyzeFrontClip, analyzeRearClip } from "../analysis.js";
import { go } from "../main.js";
import { appbar } from "../ui.js";

/* One recording session. The camera opens on arrival and stays open; you pick
   which angle the next take belongs to from inside it, in any order, and take
   as many as you like. Tapping an angle you have already filmed reviews and
   trims it in place. Only the side view is measured in v1. Nothing leaves the
   phone — the camera is released the moment you navigate away. */

const VIEWS = [
  { key: "side",  label: "Side",   need: "required",
    hint: "Phone at saddle height, 2–3 m away — whole bike and rider in frame. This is the view we measure." },
  { key: "front", label: "Front",  need: "optional",
    hint: "Phone at bar height, straight ahead — both knees visible." },
  { key: "rear",  label: "Behind", need: "optional",
    hint: "Behind the rear wheel, light from the side — never a window straight behind you." },
];

const clock = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, "0")}`;
const viewOf = (k) => VIEWS.find((v) => v.key === k);

export function renderAnalyze(view, user) {
  const state = { angle: "side", clips: {}, trims: {}, urls: {},
                  stream: null, recorder: null, timer: null, tick: null };
  drawCapture(view, user, state);
  return () => teardown(state);       // the router calls this when you leave
}

function stopCamera(state) {
  if (state.recorder && state.recorder.state !== "inactive") { try { state.recorder.stop(); } catch {} }
  clearTimeout(state.timer); clearInterval(state.tick);
  state.recorder = null;
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
}

function teardown(state) {
  stopCamera(state);
  for (const k of Object.keys(state.urls)) URL.revokeObjectURL(state.urls[k]);
  state.urls = {};
}

function drawCapture(view, user, state) {
  view.innerHTML = `
  ${appbar("capture")}
  <div class="stage glass">
    <video id="cam" class="shot" playsinline muted autoplay></video>
    <video id="play" class="shot hidden" playsinline muted loop controls></video>
    <div class="stage-msg hidden" id="stagemsg"></div>
    <div class="rec-pill hidden" id="recpill"><span class="rec-dot"></span><span id="rectime">0:00</span></div>
  </div>
  <p class="hint" id="hint"></p>
  <div class="angles" id="angles">
    ${VIEWS.map((v) => `<button class="angle" data-a="${v.key}">
        <span class="alabel">${v.label}</span><em class="astate">${v.need}</em></button>`).join("")}
  </div>
  <div class="trim hidden" id="trim">
    <div class="lbl"><span>Analyze from</span><span id="t0l">0:00</span></div>
    <input id="t0" type="range" min="0" max="100" value="0">
    <div class="lbl"><span>to</span><span id="t1l">0:00</span></div>
    <input id="t1" type="range" min="0" max="100" value="100">
  </div>
  <div class="capture-bar">
    <button class="ghost" id="import">Import a video</button>
    <button class="shutter" id="shoot" aria-label="Record"><i></i></button>
    <button class="ghost" id="retake" disabled>Retake</button>
    <input type="file" accept="video/*" class="hidden" id="file">
  </div>
  <div class="err" id="err"></div>
  <button class="btn" id="go" disabled></button>
  <div class="footnote">Filming and analysis both happen on your phone · recording stops on its own after ${Math.round(MAX_RECORD_MS / 60000)} minutes</div>`;

  const $ = (q) => view.querySelector(q);
  const cam = $("#cam"), play = $("#play"), err = $("#err"), goBtn = $("#go");
  const shoot = $("#shoot"), retake = $("#retake"), trim = $("#trim");

  const isRecording = () => !!state.recorder && state.recorder.state === "recording";

  function paint() {
    const v = viewOf(state.angle);
    const clip = state.clips[state.angle];
    $("#hint").textContent = v.hint;

    for (const btn of view.querySelectorAll(".angle")) {
      const k = btn.dataset.a;
      btn.classList.toggle("on", k === state.angle);
      btn.classList.toggle("filled", !!state.clips[k]);
      btn.disabled = isRecording() && k !== state.angle;
      const t = state.trims[k];
      btn.querySelector(".astate").textContent =
        state.clips[k] ? (t ? clock(t[1] - t[0]) : "…") : viewOf(k).need;
    }

    // Reviewing a take you already have, or looking through the lens.
    const reviewing = !!clip && !isRecording();
    play.classList.toggle("hidden", !reviewing);
    cam.classList.toggle("hidden", reviewing);
    trim.classList.toggle("hidden", !reviewing);
    retake.disabled = !clip || isRecording();
    shoot.classList.toggle("recording", isRecording());
    shoot.setAttribute("aria-label", isRecording() ? "Stop recording" : "Record");

    const ready = state.clips.side && state.trims.side;
    goBtn.disabled = !ready || isRecording();
    goBtn.textContent = ready ? "Analyze this ride →" : "Film the side view to analyze";
  }

  function showClip(key) {
    const url = state.urls[key];
    if (!url) return;
    play.src = url;
    play.onloadedmetadata = () => { syncTrim(play, view, state, key).then(paint); };
  }

  function loadClip(key, blob) {
    state.clips[key] = blob;
    if (state.urls[key]) URL.revokeObjectURL(state.urls[key]);
    state.urls[key] = URL.createObjectURL(blob);
    delete state.trims[key];
    state.angle = key;
    showClip(key);
    paint();
  }

  async function startCamera() {
    const msg = $("#stagemsg");
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 } }, audio: false });
      cam.srcObject = state.stream;
      await cam.play().catch(() => {});
      msg.classList.add("hidden");
    } catch (e) {
      // No camera is not a dead end — you can still import what you filmed.
      msg.textContent = "No camera here — import a video instead.";
      msg.classList.remove("hidden");
      shoot.disabled = true;
      err.textContent = "Camera unavailable (" + e.message + ")";
    }
  }

  view.querySelector("#angles").onclick = (e) => {
    const btn = e.target.closest(".angle");
    if (!btn || btn.disabled) return;
    state.angle = btn.dataset.a;
    if (state.clips[state.angle]) showClip(state.angle);
    paint();
  };

  shoot.onclick = () => {
    if (isRecording()) { state.recorder.stop(); return; }
    if (!state.stream) return;
    err.textContent = "";
    const key = state.angle, chunks = [];
    const recorder = new MediaRecorder(state.stream);
    recorder.ondataavailable = (ev) => chunks.push(ev.data);
    recorder.onstop = () => {
      clearTimeout(state.timer); clearInterval(state.tick);
      state.recorder = null;
      $("#recpill").classList.add("hidden");
      loadClip(key, new Blob(chunks, { type: chunks[0]?.type || "video/webm" }));
    };
    recorder.start();
    state.recorder = recorder;
    state.timer = setTimeout(() => recorder.state !== "inactive" && recorder.stop(), MAX_RECORD_MS);
    const t0 = Date.now();
    $("#recpill").classList.remove("hidden");
    state.tick = setInterval(() => { $("#rectime").textContent = clock((Date.now() - t0) / 1000); }, 250);
    // back to the lens while it rolls, even if this angle already had a take
    play.classList.add("hidden"); cam.classList.remove("hidden"); trim.classList.add("hidden");
    paint();
  };

  retake.onclick = () => {
    const key = state.angle;
    if (state.urls[key]) URL.revokeObjectURL(state.urls[key]);
    delete state.urls[key]; delete state.clips[key]; delete state.trims[key];
    play.removeAttribute("src");
    paint();
  };

  $("#import").onclick = () => $("#file").click();
  $("#file").onchange = (e) => e.target.files[0] && loadClip(state.angle, e.target.files[0]);

  goBtn.onclick = () => { if (!goBtn.disabled) { stopCamera(state); runAnalysis(view, user, state); } };

  paint();
  startCamera();
}

/* A MediaRecorder blob reports duration Infinity until its end has been seeked,
   so a freshly recorded clip would trim to nothing. Force the seek first. */
function realDuration(video) {
  if (Number.isFinite(video.duration) && video.duration > 0) return Promise.resolve(video.duration);
  return new Promise((resolve) => {
    const settle = () => {
      video.removeEventListener("timeupdate", settle);
      const d = Number.isFinite(video.duration) ? video.duration : 0;
      video.currentTime = 0;
      resolve(d);
    };
    video.addEventListener("timeupdate", settle);
    video.currentTime = 1e101;
  });
}

async function syncTrim(video, view, state, key) {
  const d = await realDuration(video);
  const t0 = view.querySelector("#t0"), t1 = view.querySelector("#t1");
  const update = () => {
    let a = (+t0.value / 100) * d, b = (+t1.value / 100) * d;
    if (b - a < 5) b = Math.min(d, a + 5);           // at least 5 s
    state.trims[key] = [a, b];
    view.querySelector("#t0l").textContent = clock(a);
    view.querySelector("#t1l").textContent = clock(b);
    const chip = view.querySelector(`.angle[data-a="${key}"] .astate`);
    if (chip) chip.textContent = clock(b - a);
    video.currentTime = a;
  };
  t0.value = 0; t1.value = 100;
  t0.oninput = update; t1.oninput = update; update();
}

async function runAnalysis(view, user, state) {
  stopCamera(state);
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

    /* The extra views never overturn the side view — they add their own
       measurements and, where they agree, corroborate its fix. A view that
       fails its own gate reports that and nothing else. */
    if (!report.gate) {
      if (state.clips.front && state.trims.front) {
        stage.textContent = "Reading your knees from the front…";
        bar.style.width = "40%";
        report.front = await analyzeFrontClip(state.clips.front, state.trims.front);
      }
      if (state.clips.rear && state.trims.rear) {
        stage.textContent = "Reading shoulders and pelvis from behind…";
        bar.style.width = "75%";
        report.rear = await analyzeRearClip(state.clips.rear, state.trims.rear);
      }
      bar.style.width = "100%";
      addExtraViewCards(report);
    }
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

/* Cards for the extra views. No verdict word where the project has no cited
   band — the number and its meaning, and nothing implied beyond it. */
function addExtraViewCards(r) {
  const f = r.front;
  if (f?.gate) {
    r.cards.push({ name: "Knees from the front", value: "—", note: f.gate });
  } else if (f) {
    r.cards.push({
      name: "Knee travel (front)",
      value: `${f.kneeTravel.left}° L · ${f.kneeTravel.right}° R`,
      note: "How far each knee leans in and out across the stroke, measured from vertical. No research band for this in FORM yet, so it is reported without a verdict.",
    });
    if (f.asymmetry) {
      const even = f.asymmetry < 1.35;
      r.cards.push({
        name: "Left / right evenness",
        value: `${f.asymmetry}×`,
        verdict: even ? "Even" : "Watch",
        note: even
          ? "Your knees travel about the same amount — this compares you with yourself, so it needs no external band."
          : `Your ${f.looser} knee travels ${f.asymmetry}× as far as the other. Worth watching; it compares you with yourself rather than a research band.`,
      });
    }
  }

  const b = r.rear;
  if (b?.gate) {
    r.cards.push({ name: "Shoulders and pelvis (behind)", value: "—", note: b.gate });
  } else if (b) {
    r.cards.push({
      name: "Pelvic rock (behind)",
      value: `${b.pelvicRock}°`,
      note: "How much your hips tilt side to side over the stroke. Reported without a verdict — FORM has no cited band for it yet.",
    });
    r.cards.push({
      name: "Shoulder rock (behind)",
      value: `${b.shoulderRock}°`,
      note: "Side-to-side tilt across the shoulders over the stroke.",
    });
    // Rocking is classic evidence of reaching for the pedals. Say so only when
    // the side view already found the same thing, so the two never disagree.
    if (r.fix?.title === "Saddle looks high" && b.pelvicRock >= 4) {
      r.fix.line += ` The rear view agrees — your hips rock ${b.pelvicRock}° chasing the bottom of the stroke.`;
    }
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
  <div class="footnote">Analyzed on your phone across ${r.strokes ?? "–"} pedal strokes · video and these frames never leave the phone · ${r.front || r.rear ? "all captured views measured" : "front & behind add more when you film them"}</div>`;
}
