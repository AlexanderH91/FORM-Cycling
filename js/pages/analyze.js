import { supa } from "../supa.js";
import { MAX_RECORD_MS, BUILD } from "../config.js";
import { analyzeSideClip, analyzeFrontClip, analyzeRearClip, overlayAt, kneeReadOf } from "../analysis.js";
import { go } from "../main.js";
import { appbar } from "../ui.js";

/* One recording session. The camera opens on arrival and stays open; you pick
   which angle the next take belongs to from inside it, in any order, and take
   as many as you like. Tapping an angle you have already filmed reviews and
   trims it in place. Only the side view is measured in v1. Nothing leaves the
   phone — the camera is released the moment you navigate away. */

const VIEWS = [
  { key: "side",  label: "Side",   need: "required",
    hint: "Phone at saddle height, 2–3 m away — whole bike and rider in frame. This is the view we measure.",
    title: "Side view", gives: "saddle height, hip fold, foot angle, cadence and fore/aft" },
  { key: "front", label: "Front",  need: "optional",
    hint: "Phone at bar height, straight ahead — both knees visible.",
    title: "Front view", gives: "whether your knees track in or out, which no other angle can see" },
  { key: "rear",  label: "Behind", need: "optional",
    hint: "Behind the rear wheel, light from the side — never a window straight behind you.",
    title: "From behind", gives: "shoulder and pelvis rock, and whether you sit level" },
];

/* Record at a bitrate that survives a bent knee against a dark bike. The
   default is tuned for video calls and smears exactly the edges we measure. */
function recorderOptions() {
  const wants = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"];
  const mimeType = wants.find((t) => window.MediaRecorder?.isTypeSupported?.(t));
  return { videoBitsPerSecond: 12_000_000, ...(mimeType ? { mimeType } : {}) };
}

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
    <video id="play" class="shot hidden" playsinline muted loop controls preload="auto"></video>
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
  <p class="hint" id="missing"></p>
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

    /* Every review of a rival app lands on "side view only". FORM films three
       — but only if the rider knows what the other two are worth, said here
       rather than in a footnote under the report. */
    const short = VIEWS.filter((v) => v.need === "optional" && !state.clips[v.key]);
    $("#missing").textContent = ready && short.length
      ? `Side only so far. ${short.map((v) => `${v.label}: ${v.gives}`).join(". ")}.`
      : "";
  }

  function showClip(key) {
    const url = state.urls[key];
    if (!url) return;
    /* A display:none video never decodes a frame, so the element has to be on
       screen BEFORE the clip loads — otherwise the card shows a black
       rectangle behind a play button no matter what we seek to. */
    play.classList.remove("hidden");
    cam.classList.add("hidden");
    play.src = url;
    play.load();
    play.onloadedmetadata = async () => {
      // Being on screen is not enough on iOS: until the element has actually
      // played, there is no decoded frame to show and the card stays black.
      try { await play.play(); play.pause(); } catch { /* seek alone, then */ }
      // Seeking to a time it already sits on fires no seek, so nudge off zero.
      play.currentTime = 0.03;
      syncTrim(play, view, state, key).then(paint);
    };
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
      /* Ask for the best the camera will give: pose accuracy and the replay
         both live off this footage. Every constraint is "ideal" — a hard one
         makes getUserMedia throw on a device that cannot meet it, and a
         lower-resolution clip beats no clip. Fall back to a plain rear camera
         if the request is refused outright. */
      const best = {
        facingMode: "environment",
        width: { ideal: 1920 }, height: { ideal: 1080 },
        frameRate: { ideal: 60 },
      };
      state.stream = await navigator.mediaDevices
        .getUserMedia({ video: best, audio: false })
        .catch(() => navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false }));
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
    const recorder = new MediaRecorder(state.stream, recorderOptions());
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
    /* Your earlier rides are evidence about the same rider on the same bike.
       The app used to tell you another ride would settle a close call and then
       never look at the ones you had already filmed. */
    const { data: prior } = await supa.from("cycling_sessions")
      .select("report").order("created_at", { ascending: false }).limit(9);
    const history = (prior ?? []).map((row) => kneeReadOf(row.report)).filter(Boolean);

    const report = await analyzeSideClip(
      state.clips.side, state.trims.side,
      (pct, msg) => { bar.style.width = pct + "%"; if (msg) stage.textContent = msg; },
      { history, heightCm: +localStorage.getItem("form_height_cm") || null });
    report.viewsCaptured = Object.keys(state.clips);

    /* The extra views never overturn the side view — they add their own
       measurements and, where they agree, corroborate its fix. A view that
       fails its own gate reports that and nothing else. */
    if (!report.gate) {
      // Each extra view owns a slice of the bar, so it keeps moving instead of
      // sitting frozen for the minute a clip takes to sample.
      const slice = (from, to) => (f) => { bar.style.width = (from + (to - from) * Math.min(1, f)) + "%"; };
      if (state.clips.front && state.trims.front) {
        stage.textContent = "Reading your knees from the front…";
        report.front = await analyzeFrontClip(state.clips.front, state.trims.front, slice(40, 70));
      }
      if (state.clips.rear && state.trims.rear) {
        stage.textContent = "Reading shoulders and pelvis from behind…";
        report.rear = await analyzeRearClip(state.clips.rear, state.trims.rear, slice(70, 96));
      }
      bar.style.width = "100%";
      addExtraViewCards(report);
    }
    // Keyframes are frames of your video. The promise is that video never
    // leaves the phone, so they are shown here and never sent to the server.
    const { keyframes, track, ...stored } = report;
    const { error } = await supa.from("cycling_sessions").insert({
      user_id: user.id,
      cadence_rpm: report.cadence ?? null,
      views_captured: report.viewsCaptured,
      report: stored,
    });
    if (error) throw error;
    drawReport(view, report, state.clips.side);
  } catch (e) {
    view.querySelector("#err").textContent = "Analysis failed: " + e.message;
    stage.textContent = "Something went wrong — your clips are still on your phone; try again.";
  }
}

/* Cards for the extra views. No verdict word where the project has no cited
   band — the number and its meaning, and nothing implied beyond it. */
/* What each view is for. Every review of a rival app lands on the same
   sentence — "analyses from one side only, does not assess front or rear" —
   and FORM films all three. That advantage is worth nothing if a view the
   rider skipped just leaves a silent hole in the report, which is what was
   happening: no card, no mention, only a line of footnote. */
function viewsBlock(r) {
  const filmed = new Set(r.viewsCaptured ?? ["side"]);
  const rows = VIEWS.map((v) => {
    const res = v.key === "side" ? r : r[v.key];
    const state = !filmed.has(v.key) ? "missing" : res?.gate ? "gated" : "done";
    const detail = state === "done" ? v.gives
      : state === "gated" ? res.gate
      : `Not filmed this time — it measures ${v.gives}.`;
    return `<div class="viewrow"><span class="vdot ${state}"></span>
      <div><b>${v.title}</b><br><span class="vnote">${detail}</span></div></div>`;
  }).join("");
  const missing = VIEWS.filter((v) => !filmed.has(v.key));
  return `
  <div class="sect">What this report is based on</div>
  <div class="glass card">${rows}
    ${missing.length ? `<a class="btn secondary" href="#/analyze" style="margin-top:12px">Film ${
      missing.map((v) => v.label.toLowerCase()).join(" and ")} next</a>` : ""}
  </div>
  <div class="glass card"><h3>What FORM does not measure</h3>
    <p>Cleat position and saddle tilt need the hardware in shot at a resolution
    phone video does not give — FORM leaves them alone rather than guessing.
    Everything above comes from your body, not your bike.</p></div>`;
}

function addExtraViewCards(r) {
  // A gate says what it saw, so a failure is diagnosable instead of mysterious.
  const why = (seen) => !seen ? "" :
    ` (found you in ${seen.posed} of ${seen.sampled} frames over ${seen.span}s, average joint confidence ${seen.visibility})`;

  const f = r.front;
  if (f?.gate) {
    r.cards.push({ name: "Knees from the front", value: "—", note: f.gate + why(f.seen) });
  } else if (f) {
    const t = f.kneeTravel;
    const both = t.left != null && t.right != null;
    r.cards.push({
      name: "Knee travel (front)",
      value: both ? `${t.left}° L · ${t.right}° R` : `${t.left ?? t.right}° ${f.oneLegOnly === "left" ? "L" : "R"}`,
      note: (both
        ? "How far each knee leans in and out across the stroke, measured from vertical."
        : `Only your ${f.oneLegOnly} knee stayed in view long enough to measure. This is how far it leans in and out across the stroke.`)
        + " No research band for this in FORM yet, so it is reported without a verdict.",
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
    r.cards.push({ name: "Shoulders and pelvis (behind)", value: "—", note: b.gate + why(b.seen) });
  } else if (b) {
    if (b.pelvicRock != null) r.cards.push({
      name: "Pelvic rock (behind)",
      value: `${b.pelvicRock}°`,
      note: "How much your hips tilt side to side over the stroke. Reported without a verdict — FORM has no cited band for it yet.",
    });
    if (b.shoulderRock != null) r.cards.push({
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

export function drawReport(view, r, sideClip) {
  const f = r.fix;
  const canPlay = !r.gate && sideClip && r.track?.length;
  view.innerHTML = `
  ${appbar("new report")}
  ${r.gate ? `
    <div class="glass card"><h3>We couldn't trust this read</h3>
      <p>${r.gate}</p></div>
    <a class="btn" href="#/analyze">Re-record</a>`
  : `
    <div class="glass card" style="border-left:3px solid ${r.provisional ? "#E0603A" : "var(--gold)"}">
      <div class="sect" style="margin:0 0 6px${r.provisional ? ";color:#E0603A" : ""}">${
        r.provisional ? "Provisional read" : "This ride's fix"}</div>
      <h2>${f.title}</h2><p>${f.line}</p>
      <p><strong>Try:</strong> ${f.cue}</p>
      ${f.why ? `<p class="why"><strong>What that gets you:</strong> ${f.why}</p>` : ""}
      ${r.provisional ? `<p>The numbers below are shown without verdicts.</p>` : ""}
    </div>
    ${canPlay ? `
      <div class="sect">Your ride, measured</div>
      <div class="glass player">
        <div class="stagewrap">
          <video id="mv" class="shot" playsinline muted loop preload="auto"></video>
          <canvas id="mvc"></canvas>
          <div class="mv-live mono"><span id="mvang">–</span></div>
        </div>
        <div class="mv-bar">
          <button class="mv-play" id="mvplay" aria-label="Play">▶</button>
          <input id="mvseek" type="range" min="0" max="1000" value="0">
          <div class="mv-speeds">
            ${[0.25, 0.5, 1].map((x) => `<button data-x="${x}" class="${x === 1 ? "on" : ""}">${x}×</button>`).join("")}
          </div>
        </div>
        <figcaption>Knee angle, drawn on the joints the model found in each frame. Green in band, gold out.</figcaption>
      </div>` : ""}
    ${/* Stills live inside the card that claims each number now. This only
          speaks up when they could not be made at all. */""}
    ${r.keyframes?.length ? "" : `<div class="glass card"><p><strong>No stills this time</strong> — ${
      r.stillsFail ?? "the frames could not be pulled back out of the clip"}. The measurements below are unaffected; they were read from the clip as it was sampled.</p></div>`}
    <div class="sect">Measured</div>
    ${r.cards.map((c) => `
      <div class="glass card"><div class="row"><h3>${c.name}</h3>
        <div class="val">${c.value} ${c.verdict ? `<em>${c.verdict}</em>` : ""}</div></div>
        ${/* The frame the number came from, inside the card that claims it. */""}
        ${c.shot ? `<figure class="cardshot">
            <img src="${c.shot.src}" alt="${c.name} measured on your ride" loading="lazy">
            ${c.shot.drawn ? `<figcaption>${c.shot.caption}</figcaption>`
              : `<figcaption>Your frame at that moment. The joints were not clear enough here to draw on, so nothing is drawn.</figcaption>`}
          </figure>` : ""}
        <p>${c.note}</p></div>`).join("")}
    ${viewsBlock(r)}
    <a class="btn secondary coach-cta" href="#/coach?about=report">
      <span class="cmic"></span>Talk about this ride</a>
    <a class="btn" href="#/home">Done</a>`}
  <div class="footnote">Analyzed on your phone across ${r.strokes ?? "–"} pedal strokes${
    r.capture?.offSquareDeg != null ? ` · camera about ${r.capture.offSquareDeg}° off square` : ""} · build ${BUILD} · video and these frames never leave the phone · ${r.front || r.rear ? "all captured views measured" : "front & behind add more when you film them"}</div>`;
  if (canPlay) wirePlayer(view, r, sideClip);
}

/* Where the picture actually sits inside its box under object-fit: contain.
   Landmarks are normalised to the video frame, so without this the skeleton
   lands wherever the letterbox isn't. */
export function fitContain(boxW, boxH, vidW, vidH) {
  if (!boxW || !boxH) return null;
  if (!vidW || !vidH) return { x: 0, y: 0, w: boxW, h: boxH };
  const scale = Math.min(boxW / vidW, boxH / vidH);
  const w = vidW * scale, h = vidH * scale;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

/* Plays the analysed section back with the measurement riding on the rider.
   The track is frame-aligned to the clip, so at any moment we draw the joints
   the model actually found nearest that time — and nothing when it found none,
   which is the same rule the stills follow. */
function wirePlayer(view, r, clip) {
  const video = view.querySelector("#mv");
  const canvas = view.querySelector("#mvc");
  const live = view.querySelector("#mvang");
  const playBtn = view.querySelector("#mvplay");
  const seek = view.querySelector("#mvseek");
  if (!video || !clip) return () => {};

  const url = URL.createObjectURL(clip);
  video.src = url;
  const [t0, t1] = r.trim ?? [0, 0];
  const track = r.track;
  const ctx = canvas.getContext("2d");

  /* Landmarks are normalised to the VIDEO FRAME, not to the element. If the
     frame is letterboxed inside its box — which it is the moment the clip's
     aspect and the card's differ — mapping straight onto the element puts the
     skeleton somewhere the rider is not. Find where the picture actually sits
     and map into that. */
  const contentRect = () =>
    fitContain(video.clientWidth, video.clientHeight, video.videoWidth, video.videoHeight);

  function draw() {
    const box = contentRect();
    if (!box) return;
    const bw = video.clientWidth, bh = video.clientHeight;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    // Height matters as much as width — checking only width left a stale
    // bitmap once the real aspect arrived, and every point drew low.
    if (canvas.width !== Math.round(bw * dpr) || canvas.height !== Math.round(bh * dpr)) {
      canvas.width = Math.round(bw * dpr);
      canvas.height = Math.round(bh * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, bw, bh);

    // No landmarks near this moment: draw nothing rather than a stale pose.
    const f = overlayAt(track, video.currentTime);
    if (!f) { live.textContent = "–"; return; }
    const at = (p) => [box.x + p.x * box.w, box.y + p.y * box.h];
    const colour = f.inBand ? "#34D27B" : "#F2C230";
    const pts = [f.j.hip, f.j.knee, f.j.ankle].map(at);
    ctx.lineWidth = Math.max(3, box.w * 0.011);
    ctx.lineJoin = ctx.lineCap = "round";
    ctx.strokeStyle = colour;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
    ctx.fillStyle = colour;
    for (const [x, y] of pts) { ctx.beginPath(); ctx.arc(x, y, ctx.lineWidth * 1.1, 0, Math.PI * 2); ctx.fill(); }
    live.textContent = `${f.knee.toFixed(0)}°`;
    live.style.color = colour;
  }

  /* Drive the overlay off the frames the video actually presents where the
     browser offers that, so the skeleton is redrawn for the frame on screen
     rather than for whenever rAF happened to fire. timeupdate alone fires
     about four times a second, which is nowhere near a pedal stroke. */
  let raf = null;
  const useVFC = typeof video.requestVideoFrameCallback === "function";
  const loop = () => {
    draw();
    if (video.paused) return;
    seek.value = String(((video.currentTime - t0) / Math.max(0.001, t1 - t0)) * 1000);
    raf = useVFC ? video.requestVideoFrameCallback(loop) : requestAnimationFrame(loop);
  };
  // One canceller: a video-frame callback handle is not an animation-frame one,
  // and cancelling the wrong kind leaves the loop running after teardown.
  const stop = () => {
    if (raf == null) return;
    if (useVFC) video.cancelVideoFrameCallback?.(raf); else cancelAnimationFrame(raf);
    raf = null;
  };

  video.onloadedmetadata = async () => {
    /* A muted inline video that has never played shows black on iOS, however
       carefully you seek it — the decoder has produced nothing to show. Play it
       for an instant and pause: that is what puts a real first frame under the
       overlay instead of a skeleton floating on a black rectangle. */
    try { await video.play(); video.pause(); } catch { /* seek alone, then */ }
    // Nudge off the exact start: seeking to a time it already sits on fires no
    // seek, so the element stays black behind a play button.
    video.currentTime = t0 + 0.03;
    draw();
  };
  video.onloadeddata = draw;
  video.onresize = draw;
  video.onseeked = draw;
  video.ontimeupdate = draw;
  playBtn.onclick = () => {
    if (video.paused) { if (video.currentTime >= t1 - 0.05) video.currentTime = t0; video.play(); playBtn.textContent = "❚❚"; loop(); }
    else { video.pause(); playBtn.textContent = "▶"; stop(); }
  };
  video.onplay = () => { playBtn.textContent = "❚❚"; loop(); };
  video.onpause = () => { playBtn.textContent = "▶"; stop(); };
  // Loop the trimmed section, not the whole clip.
  const fence = () => { if (video.currentTime > t1) video.currentTime = t0; };
  video.addEventListener("timeupdate", fence);
  seek.oninput = () => { video.currentTime = t0 + (+seek.value / 1000) * (t1 - t0); draw(); };
  for (const b of view.querySelectorAll(".mv-speeds button")) {
    b.onclick = () => {
      video.playbackRate = +b.dataset.x;
      view.querySelectorAll(".mv-speeds button").forEach((o) => o.classList.toggle("on", o === b));
    };
  }
  addEventListener("resize", draw);

  return () => { stop(); video.pause(); video.removeAttribute("src"); URL.revokeObjectURL(url); };
}
