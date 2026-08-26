import { supa } from "../supa.js";
import { appbar } from "../ui.js";

/* Voice coach — working preview.

   The screen, the orb and the turn-taking are real. The voice is not yet
   OpenAI's: it listens through the Web Audio API (so the orb reacts to your
   actual microphone) and answers through the browser's own speech synthesis.

   To make it real, replace speak()/listen() with an OpenAI Realtime session.
   That needs an EPHEMERAL token, minted server-side — an OpenAI key cannot
   live in this repo, js/config.js is public and served to every visitor. The
   intended shape is a Supabase Edge Function that holds the key and returns a
   short-lived client secret, which this page swaps for a WebRTC session.
   See COACH_TOKEN_ENDPOINT below.

   What the coach says is built from the stored report and nothing else. It
   never generates a number: every figure it reads aloud came off the rider's
   own video. That constraint has to survive the swap to a language model —
   the model may choose the words, never the measurements. */

const COACH_TOKEN_ENDPOINT = null;   // e.g. `${SUPABASE_URL}/functions/v1/coach-token`

export async function renderCoach(view) {
  const { data: sessions } = await supa
    .from("cycling_sessions")
    .select("created_at, report")
    .order("created_at", { ascending: false })
    .limit(1);
  const report = sessions?.[0]?.report ?? null;

  view.innerHTML = `
  ${appbar("coach")}
  <div class="coach">
    <div class="orb" id="orb">
      <i class="ring r3"></i><i class="ring r2"></i><i class="ring r1"></i>
      <i class="core"></i>
    </div>
    <div class="coach-state mono" id="cstate">Tap to start</div>
    <p class="coach-line" id="cline">${report
      ? "I've read your last ride. Ask me about it, or tap and I'll take you through the one thing that matters."
      : "No ride to talk about yet — film one and I'll take you through it."}</p>
    <div class="coach-controls">
      <button class="ghost" id="cstop" disabled>Stop</button>
      <button class="mic" id="cmic" aria-label="Talk to your coach"><span></span></button>
      <button class="ghost" id="ctext">Read it</button>
    </div>
    <div class="coach-note mono">Preview · voice runs on your phone · OpenAI Realtime not connected</div>
  </div>`;

  const $ = (q) => view.querySelector(q);
  const orb = $("#orb"), cstate = $("#cstate"), cline = $("#cline");
  const mic = $("#cmic"), stop = $("#cstop");

  let audioCtx = null, stream = null, raf = null, analyser = null;
  let speaking = false, listening = false;

  const setAmp = (v) => orb.style.setProperty("--amp", v.toFixed(3));
  const setState = (mode, label) => {
    orb.dataset.mode = mode;
    cstate.textContent = label;
    stop.disabled = mode === "idle";
    mic.classList.toggle("on", mode === "listening");
  };

  /* Everything the coach can say, assembled from the report. No sentence here
     introduces a figure the analysis did not produce. */
  function script() {
    if (!report) return ["You haven't filmed a ride yet. Film the side view and I'll have something to tell you."];
    if (report.gate) return ["I couldn't trust the last read.", report.gate];
    const lines = [`Here's the one thing from your last ride. ${report.fix.title}.`, report.fix.line, `Try this. ${report.fix.cue}`];
    const knee = report.cards?.find((c) => c.name?.startsWith("Knee at"));
    if (knee) lines.push(`For reference, ${knee.name.toLowerCase()} measured ${knee.value}, across ${report.strokes} strokes.`);
    if (report.front?.asymmetry && report.front.asymmetry >= 1.35)
      lines.push(`One more thing from the front view — your ${report.front.looser} knee travels ${report.front.asymmetry} times as far as the other.`);
    return lines;
  }

  function speak(lines) {
    if (!window.speechSynthesis) { cline.textContent = lines.join(" "); return; }
    window.speechSynthesis.cancel();
    speaking = true;
    setState("speaking", "Coach");
    let t = 0;
    const envelope = () => {           // stand-in for real output levels
      if (!speaking) return;
      t += 0.09;
      setAmp(0.45 + 0.3 * Math.abs(Math.sin(t)) + 0.12 * Math.abs(Math.sin(t * 2.7)));
      raf = requestAnimationFrame(envelope);
    };
    envelope();
    lines.forEach((line, i) => {
      const u = new SpeechSynthesisUtterance(line);
      u.rate = 1.02; u.pitch = 1;
      u.onstart = () => { cline.textContent = line; };
      if (i === lines.length - 1) u.onend = () => endTurn();
      window.speechSynthesis.speak(u);
    });
  }

  async function listen() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      cline.textContent = "I can't hear you without microphone access — tap Read it and I'll talk you through it instead.";
      setState("idle", "Tap to start");
      return;
    }
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    audioCtx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    listening = true;
    setState("listening", "Listening");
    const loop = () => {
      if (!listening) return;
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) { const d = (v - 128) / 128; sum += d * d; }
      setAmp(Math.min(1, Math.sqrt(sum / buf.length) * 6));
      raf = requestAnimationFrame(loop);
    };
    loop();
  }

  function endTurn() {
    speaking = false; listening = false;
    cancelAnimationFrame(raf);
    window.speechSynthesis?.cancel();
    stream?.getTracks().forEach((t) => t.stop()); stream = null;
    audioCtx?.close().catch(() => {}); audioCtx = null;
    setAmp(0.18);
    setState("idle", "Tap to start");
  }

  mic.onclick = async () => {
    if (listening) {
      // A real session streams this to the model; the preview answers from the report.
      listening = false; cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop()); stream = null;
      audioCtx?.close().catch(() => {}); audioCtx = null;
      setState("thinking", "Thinking");
      setTimeout(() => speak(script()), 550);
      return;
    }
    if (speaking) { endTurn(); return; }
    await listen();
  };

  $("#ctext").onclick = () => { if (!speaking) speak(script()); };
  stop.onclick = endTurn;

  setAmp(0.18);
  setState("idle", "Tap to start");
  return endTurn;          // the router stops the mic when you navigate away
}
