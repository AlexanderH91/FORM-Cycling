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
    /* Bar height was wrong guidance, and it was mine. At bar height the bars
       and the levers sit across exactly the part of the leg this view needs,
       so the model ends up guessing at knees it cannot see. Low and further
       back puts the legs in clear air. */
    hint: "Phone low — about hub height — and 2–3 m in front. Knees and feet in clear view, not behind the bars.",
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
  /* The report's player keeps a video decoding and a frame callback running.
     Its teardown was being returned and dropped on the floor, so leaving the
     report left both alive — which on a phone is a video still decoding behind
     whatever screen you moved to. */
  try { state.disposePlayer?.(); } catch { /* a failed teardown must not block the rest */ }
  state.disposePlayer = null;
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
  <div class="anglehead"><span id="progress"></span></div>
  <div class="angles" id="angles">
    ${VIEWS.map((v) => `<button class="angle" data-a="${v.key}">
        <span class="alabel">${v.label}</span><em class="astate"></em></button>`).join("")}
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
  ${/* Not a grey hint under the button. Filming one angle and stopping was the
        default because nothing ever asked for the next one. */""}
  <div class="nextup hidden" id="next"></div>
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
        state.clips[k] ? (t ? `\u2713 ${clock(t[1] - t[0])}` : "…") : "not filmed";
    }

    const filmed = VIEWS.filter((v) => state.clips[v.key]).length;
    $("#progress").textContent = filmed
      ? `${filmed} of ${VIEWS.length} angles filmed`
      : "Film all three and FORM reads all three";

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

    /* Ask for the next angle, by name, with the reason and the setup. Every
       report this rider has produced says "side only" — not because they chose
       side only, but because nothing ever invited them to turn the phone. */
    const nextUp = VIEWS.find((v) => !state.clips[v.key]);
    const next = $("#next");
    next.classList.toggle("hidden", !ready || !nextUp || isRecording());
    if (ready && nextUp && !isRecording()) {
      next.innerHTML = `
        <div class="nextlbl">Next angle</div>
        <h3>${nextUp.title}</h3>
        <p>Measures ${nextUp.gives}.</p>
        <p class="nexthow">${nextUp.hint}</p>
        <button class="btn secondary" data-goto="${nextUp.key}">Film the ${nextUp.label.toLowerCase()} view</button>`;
      next.querySelector("[data-goto]").onclick = () => { state.angle = nextUp.key; showLens(); paint(); };
    }
  }

  /* Going to an angle you have not filmed means going back to the camera —
     the review element stays loaded otherwise and you look at the last take. */
  function showLens() {
    play.pause();
    play.classList.add("hidden");
    cam.classList.remove("hidden");
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
    if (state.clips[state.angle]) showClip(state.angle); else showLens();
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
    /* Per-frame joint positions are derived from the video, so they are held
       in memory for the player and never sent. The front and rear views now
       carry their own tracks too — stripping only the top-level one would have
       quietly shipped those. */
    const strip = (o) => { if (!o) return o; const { track, ...rest } = o; return rest; };
    const { keyframes, track, ...top } = report;
    const stored = { ...top, front: strip(top.front), rear: strip(top.rear) };
    const { error } = await supa.from("cycling_sessions").insert({
      user_id: user.id,
      cadence_rpm: report.cadence ?? null,
      views_captured: report.viewsCaptured,
      report: stored,
    });
    if (error) throw error;
    state.disposePlayer = drawReport(view, report, state.clips);
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
    r.cards.push({ name: "Knees from the front", value: "—", note: f.gate + why(f.seen),
      means: "The front view is the only one that can see a knee tracking in or out — no other angle shows it. Worth another go, because it is where most knee aches are explained." });
  } else if (f) {
    const t = f.kneeTravel;
    const both = t.left != null && t.right != null;
    r.cards.push({
      name: "Knee travel (front)", shot: f.stills?.knees,
      means: "A knee that swings in or out is spending part of every stroke sideways instead of down, and it is the pattern most often sitting behind an ache on the inside or outside of the joint. Cleat position, saddle height and foot support all move it — which is why it is worth knowing before you change any of them.",
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
        means: "A leg travelling further than the other is doing a different job. Riders usually meet it as one side tiring first on a long climb, or as a saddle that never quite feels square underneath them.",
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
    r.cards.push({ name: "Shoulders and pelvis (behind)", value: "—", note: b.gate + why(b.seen),
      means: "From behind, FORM can see whether you sit level or rock to chase the pedals — the check that confirms or contradicts the saddle-height reading from the side." });
  } else if (b) {
    if (b.pelvicRock != null) r.cards.push({
      name: "Pelvic rock (behind)", shot: b.stills?.body,
      means: "Hips rocking side to side usually means you are reaching for the bottom of the stroke — the classic sign of a saddle a touch too high. Every degree of rock is movement going sideways instead of into the pedals, and it is what starts rubbing after two hours.",
      value: `${b.pelvicRock}°`,
      note: "How much your hips tilt side to side over the stroke. Reported without a verdict — FORM has no cited band for it yet.",
    });
    if (b.shoulderRock != null) r.cards.push({
      name: "Shoulder rock (behind)", shot: b.stills?.body,
      means: "Shoulders usually follow the hips. On its own this can simply be how you ride; sitting next to pelvic rock, it is the same story told twice, and it is the hips that need fixing.",
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

export function drawReport(view, r, clips) {
  const f = r.fix;
  const canPlay = !r.gate && clips?.side && r.track?.length;
  view.innerHTML = `
  ${appbar("new report")}
  ${r.gate ? `
    <div class="glass card"><h3>We couldn't trust this read</h3>
      <p>${r.gate}</p></div>
    <a class="btn" href="#/analyze">Re-record</a>`
  : `
    ${/* Your ride first, then the verdict on it. A rider opening a report
          should see themselves before they see a judgement — and the angle
          tabs are also the fastest explanation of what FORM looked at. */""}
    ${canPlay ? `
      <div class="sect">Your ride</div>
      <div class="glass player">
        ${/* One player, three angles. Switching tabs is how a rider sees what
              each camera position is actually for. */""}
        <div class="angletabs" id="mvtabs"></div>
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
        <div class="mv-tools">
          <button id="mvlines" class="tool on"><span class="tico">◠</span>Lines</button>
          <button id="mvsave" class="tool"><span class="tico">↓</span>Save frame</button>
          <a href="#/coach?about=report" class="tool"><span class="tico cmic"></span>Coach</a>
        </div>
        <figcaption id="mvcap"></figcaption>
      </div>` : ""}
    <div class="glass card" style="border-left:3px solid ${r.provisional ? "#E0603A" : "var(--gold)"}">
      <div class="sect" style="margin:0 0 6px${r.provisional ? ";color:#E0603A" : ""}">${
        r.provisional ? "Provisional read" : "This ride's fix"}</div>
      <h2>${f.title}</h2><p>${f.line}</p>
      <p><strong>Try:</strong> ${f.cue}</p>
      ${f.why ? `<p class="why"><strong>What that gets you:</strong> ${f.why}</p>` : ""}
      ${/* Without a date for the change there is no before and no after, and
            the Journey screen is just a fitness chart. FORM never assumes its
            advice was taken — the rider says so. */""}
      <button class="btn secondary" id="madeit">I made this change</button>
      <div class="ok" id="madeitmsg"></div>
      ${r.provisional ? `<p>The numbers below are shown without verdicts.</p>` : ""}
    </div>
    ${/* Stills live inside the card that claims each number now. This only
          speaks up when they could not be made at all. */""}
    ${r.keyframes?.length ? "" : `<div class="glass card"><p><strong>No stills this time</strong> — ${
      r.stillsFail ?? "the frames could not be pulled back out of the clip"}. The measurements below are unaffected; they were read from the clip as it was sampled.</p></div>`}
    <div class="sect">Measured</div>
    ${/* Meaning on the face of the card; the numbers and the frame behind one
          tap. A rider opening a report wants to know what it means for their
          riding — the band and the standard deviation are the working, and
          working belongs underneath. */""}
    ${r.cards.map((c, i) => `
      <div class="glass card mcard" data-card="${i}">
        <button class="mhead" type="button" aria-expanded="false" aria-controls="mbody${i}">
          <span class="row"><h3>${c.name}</h3>
            <span class="val">${c.value} ${c.verdict ? `<em>${c.verdict}</em>` : ""}</span></span>
          ${c.means ? `<span class="means">${c.means}</span>` : ""}
          <span class="mtoggle">${c.shot ? "See it on your ride" : "See the numbers"}<i>▾</i></span>
        </button>
        <div class="mbody" id="mbody${i}" hidden>
          ${c.shot ? `<figure class="cardshot">
              <img src="${c.shot.src}" alt="${c.name} measured on your ride" loading="lazy">
              ${c.shot.drawn ? `<figcaption>${c.shot.caption}</figcaption>`
                : `<figcaption>Your frame at that moment. The joints were not clear enough here to draw on, so nothing is drawn.</figcaption>`}
            </figure>` : ""}
          <p>${c.note}</p>
        </div>
      </div>`).join("")}
    ${viewsBlock(r)}
    <a class="btn secondary coach-cta" href="#/coach?about=report">
      <span class="cmic"></span>Talk about this ride</a>
    <a class="btn" href="#/home">Done</a>`}
  <div class="footnote">Analyzed on your phone across ${r.strokes ?? "–"} pedal strokes${
    r.capture?.offSquareDeg != null ? ` · camera about ${r.capture.offSquareDeg}° off square` : ""} · build ${BUILD} · video and these frames never leave the phone · ${r.front || r.rear ? "all captured views measured" : "front & behind add more when you film them"}
    ${/* What the accurate model cost, in seconds, on this phone. Reported
          because "does heavy take too long?" is a question with an answer, and
          a rider on a slow connection deserves to see where the time went. */""}
    ${r.refined ? `<br>${
      r.refined.strokes
        ? `${r.refined.strokes} strokes re-read with the ${r.refined.model} model${
            r.refined.top ? `, ${r.refined.top} at the top too` : ""}${
            r.refined.fineReads ? ` · ${r.refined.fineReads} frames looked at` : ""}`
        : `read with the ${r.refined.sweep} model only${r.refined.fineModelError ? ` — ${r.refined.fineModelError}` : ""}`}${
      r.refined.modelLoadMs != null ? ` · model loaded in ${(r.refined.modelLoadMs / 1000).toFixed(1)}s` : ""}${
      r.refined.refineMs != null ? ` · re-read took ${(r.refined.refineMs / 1000).toFixed(1)}s` : ""}${
      r.refined.totalMs != null ? ` · ${(r.refined.totalMs / 1000).toFixed(1)}s in total` : ""}` : ""}</div>`;
  const made = view.querySelector("#madeit");
  if (made) made.onclick = async () => {
    made.disabled = true;
    const msg = view.querySelector("#madeitmsg");
    const { data: { user } } = await supa.auth.getUser();
    const { error } = await supa.from("fit_changes").insert({
      user_id: user?.id,
      part: r.fix?.title ?? "Bike change",
      note: r.fix?.cue ?? null,
      changed_at: new Date().toISOString(),
    });
    if (error) { msg.textContent = "Could not save that: " + error.message; made.disabled = false; return; }
    msg.innerHTML = `Logged for today. Your rides from here on are the "after" — see it on <a href="#/journey">Journey</a>.`;
    made.textContent = "Change logged";
  };

  /* Meaning on the face, working underneath. Native <details> would do this,
     but the summary marker fights the card layout on iOS, so it is a button
     and a hidden panel with the aria wiring done by hand. */
  for (const head of view.querySelectorAll(".mhead")) {
    head.onclick = () => {
      const body = view.querySelector("#" + head.getAttribute("aria-controls"));
      const open = head.getAttribute("aria-expanded") === "true";
      head.setAttribute("aria-expanded", String(!open));
      body.hidden = open;
      head.closest(".mcard").classList.toggle("open", !open);
    };
  }

  if (canPlay) return wirePlayer(view, r, clips);
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

/* What each angle draws, and what it is showing you.
   The side view measures a joint angle, so it draws the joint. The front view
   measures how far a knee leans, so it draws each shin against a plumb line —
   the reference it is being judged against. The rear view measures tilt, so it
   draws the shoulder and hip lines against level. In every case the dashed
   line is the reference and the solid one is the rider. */
const ANGLE_VIEWS = {
  side: {
    label: "Side",
    caption: "Knee angle, drawn on the joints the model found in each frame. Green in band, gold out.",
    track: (r) => r.track,
    trim: (r) => r.trim,
    readout: (f) => (typeof f.knee === "number" ? `${f.knee.toFixed(0)}°` : "–"),
    colour: (f) => (f.inBand ? IN_BAND : OUT),
    draw(ctx, f, at, lw) {
      // overlayAt drops a joint the model lost between samples, so check
      // before mapping rather than drawing to undefined.
      if (!f.j.hip || !f.j.knee || !f.j.ankle) return;
      line(ctx, [f.j.hip, f.j.knee, f.j.ankle].map(at), this.colour(f), lw);
    },
  },
  front: {
    label: "Front",
    caption: "Each shin against a plumb line. The gap at the knee is how far it leans in or out across the stroke.",
    track: (r) => r.front?.track,
    trim: (r) => r.front?.trim,
    readout: (f) => {
      const v = [f.left, f.right].filter((x) => typeof x === "number");
      return v.length ? `${Math.max(...v.map(Math.abs)).toFixed(0)}°` : "–";
    },
    draw(ctx, f, at, lw) {
      for (const [knee, ankle] of [["lknee", "lankle"], ["rknee", "rankle"]]) {
        if (!f.j[knee] || !f.j[ankle]) continue;
        const k = at(f.j[knee]), a = at(f.j[ankle]);
        dashed(ctx, [a[0], a[1]], [a[0], k[1]], lw);      // straight up from the ankle
        line(ctx, [k, a], OUT, lw);
      }
    },
  },
  rear: {
    label: "Behind",
    caption: "Your shoulder line and hip line against level. Tilt here is the rocking that chases the pedals.",
    track: (r) => r.rear?.track,
    trim: (r) => r.rear?.trim,
    readout: (f) => (typeof f.pelvis === "number" ? `${Math.abs(f.pelvis).toFixed(0)}°` : "–"),
    draw(ctx, f, at, lw) {
      for (const [l, rgt] of [["lsho", "rsho"], ["lhip", "rhip"]]) {
        if (!f.j[l] || !f.j[rgt]) continue;
        const A = at(f.j[l]), B = at(f.j[rgt]);
        const mid = (A[1] + B[1]) / 2;
        dashed(ctx, [A[0], mid], [B[0], mid], lw);        // level
        line(ctx, [A, B], OUT, lw);
      }
    },
  },
};

const IN_BAND = "#34D27B";
const OUT = "#F2C230";

function line(ctx, pts, colour, lw) {
  ctx.lineWidth = lw; ctx.lineJoin = ctx.lineCap = "round"; ctx.strokeStyle = colour;
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();
  ctx.fillStyle = colour;
  for (const [x, y] of pts) { ctx.beginPath(); ctx.arc(x, y, lw * 1.1, 0, Math.PI * 2); ctx.fill(); }
}

function dashed(ctx, a, b, lw) {
  ctx.save();
  ctx.setLineDash([lw * 1.6, lw * 1.6]);
  ctx.lineWidth = Math.max(1.5, lw * 0.45);
  ctx.strokeStyle = "rgba(255,255,255,.55)";
  ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
  ctx.restore();
}

/* Plays the analysed section back with the measurement riding on the rider.export function fitContain(boxW, boxH, vidW, vidH) {
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
function wirePlayer(view, r, clips) {
  const video = view.querySelector("#mv");
  const canvas = view.querySelector("#mvc");
  const live = view.querySelector("#mvang");
  const playBtn = view.querySelector("#mvplay");
  const seek = view.querySelector("#mvseek");
  const tabs = view.querySelector("#mvtabs");
  const cap = view.querySelector("#mvcap");
  if (!video || !clips?.side) return () => {};

  // Only angles that have both footage and something measured on them.
  const available = Object.entries(ANGLE_VIEWS)
    .filter(([k, v]) => clips[k] && v.track(r)?.length)
    .map(([k]) => k);
  if (!available.length) return () => {};

  let angle = available[0];
  let url = null, raf = null, showLines = true;
  const ctx = canvas.getContext("2d");
  const useVFC = typeof video.requestVideoFrameCallback === "function";
  const spec = () => ANGLE_VIEWS[angle];
  const range = () => spec().trim(r) ?? [0, video.duration || 0];

  /* Landmarks are normalised to the VIDEO FRAME, not the element. Find where
     the picture actually sits inside its box and map into that. */
  const contentRect = () =>
    fitContain(video.clientWidth, video.clientHeight, video.videoWidth, video.videoHeight);

  function draw() {
    const box = contentRect();
    if (!box) return;
    const bw = video.clientWidth, bh = video.clientHeight;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(bw * dpr) || canvas.height !== Math.round(bh * dpr)) {
      canvas.width = Math.round(bw * dpr);
      canvas.height = Math.round(bh * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, bw, bh);

    const f = overlayAt(spec().track(r), video.currentTime);
    if (!f) { live.textContent = "\u2013"; return; }
    live.textContent = spec().readout(f);
    live.style.color = f.inBand ? IN_BAND : OUT;
    if (!showLines) return;
    const at = (p) => [box.x + p.x * box.w, box.y + p.y * box.h];
    spec().draw(ctx, f, at, Math.max(3, box.w * 0.011));
  }

  const loop = () => {
    draw();
    if (video.paused) return;
    const [t0, t1] = range();
    seek.value = String(((video.currentTime - t0) / Math.max(0.001, t1 - t0)) * 1000);
    raf = useVFC ? video.requestVideoFrameCallback(loop) : requestAnimationFrame(loop);
  };
  const stop = () => {
    if (raf == null) return;
    if (useVFC) video.cancelVideoFrameCallback?.(raf); else cancelAnimationFrame(raf);
    raf = null;
  };

  async function load(next) {
    stop();
    angle = next;
    for (const b of tabs.querySelectorAll("button")) b.classList.toggle("on", b.dataset.a === angle);
    cap.textContent = spec().caption;
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(clips[angle]);
    video.src = url;
    video.load();
    playBtn.textContent = "\u25b6";
    video.onloadedmetadata = async () => {
      // Until a muted inline video has actually played, iOS has decoded no
      // frame and the element shows black however carefully you seek it.
      try { await video.play(); video.pause(); } catch { /* seek alone, then */ }
      video.currentTime = range()[0] + 0.03;
      draw();
    };
  }

  tabs.innerHTML = available.map((k) =>
    `<button data-a="${k}" class="${k === angle ? "on" : ""}">${ANGLE_VIEWS[k].label}</button>`).join("");
  for (const b of tabs.querySelectorAll("button")) b.onclick = () => load(b.dataset.a);

  video.onloadeddata = draw;
  video.onresize = draw;
  video.onseeked = draw;
  video.ontimeupdate = draw;
  video.onpause = () => { playBtn.textContent = "\u25b6"; stop(); };
  addEventListener("resize", draw);

  playBtn.onclick = () => {
    const [t0, t1] = range();
    if (video.paused) {
      if (video.currentTime >= t1 - 0.05 || video.currentTime < t0) video.currentTime = t0;
      video.play(); playBtn.textContent = "\u275a\u275a"; loop();
    } else { video.pause(); playBtn.textContent = "\u25b6"; stop(); }
  };
  seek.oninput = () => {
    const [t0, t1] = range();
    video.currentTime = t0 + (t1 - t0) * (seek.value / 1000);
  };
  for (const b of view.querySelectorAll(".mv-speeds button")) {
    b.onclick = () => {
      video.playbackRate = +b.dataset.x;
      for (const o of view.querySelectorAll(".mv-speeds button")) o.classList.toggle("on", o === b);
    };
  }

  const linesBtn = view.querySelector("#mvlines");
  linesBtn.onclick = () => {
    showLines = !showLines;
    linesBtn.classList.toggle("on", showLines);
    draw();
  };

  /* Save the frame you are looking at, lines and all. Burning the overlay into
     the video would mean re-encoding it, which costs as long again as the clip;
     a still is instant and is the thing worth showing someone. */
  const saveBtn = view.querySelector("#mvsave");
  saveBtn.onclick = async () => {
    const was = saveBtn.textContent;
    saveBtn.textContent = "Saving\u2026";
    try {
      const out = document.createElement("canvas");
      out.width = video.videoWidth; out.height = video.videoHeight;
      const g = out.getContext("2d");
      g.drawImage(video, 0, 0, out.width, out.height);
      const f = showLines ? overlayAt(spec().track(r), video.currentTime) : null;
      if (f) {
        const at = (p) => [p.x * out.width, p.y * out.height];
        spec().draw(g, f, at, Math.max(4, out.width * 0.011));
      }
      const blob = await new Promise((res) => out.toBlob(res, "image/jpeg", 0.92));
      const file = new File([blob], `form-${angle}-${Date.now()}.jpg`, { type: "image/jpeg" });
      // Sharing is how a phone actually saves a picture; a download link is
      // the desktop fallback.
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file] });
      else {
        const href = URL.createObjectURL(blob);
        const a = Object.assign(document.createElement("a"), { href, download: file.name });
        a.click();
        setTimeout(() => URL.revokeObjectURL(href), 4000);
      }
      saveBtn.textContent = "Saved";
      setTimeout(() => { saveBtn.textContent = was; }, 1600);
    } catch {
      saveBtn.textContent = was;                 // a cancelled share is not an error
    }
  };

  load(angle);
  return () => { stop(); video.pause(); video.removeAttribute("src"); if (url) URL.revokeObjectURL(url); };
}
