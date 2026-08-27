import { supa } from "../supa.js";
import { COACH_TOKEN_ENDPOINT } from "../config.js";
import { appbar } from "../ui.js";

/* Voice coach.

   Live path: a Supabase Edge Function (supabase/functions/coach-token) holds
   the OpenAI key and returns a client secret good for about a minute. The
   browser trades that for a WebRTC session with the Realtime API and talks to
   it directly — audio never passes through our servers. The key cannot live in
   this repo: js/config.js is public and served to every visitor.

   Preview path: if the endpoint is unset, unreachable, or has no key yet, the
   coach falls back to the browser's own speech synthesis reading the report.
   It says which one you are on rather than pretending.

   Either way the numbers come from the stored report. The live coach is told,
   server-side, that it may choose its words but never a measurement. */

const REALTIME_CALLS = "https://api.openai.com/v1/realtime/calls";

/* Two subjects, decided by where you came from: Home asks about progress
   across sessions, a report asks about that ride. The coach arrives already
   knowing which, so it never opens by asking what you want to talk about. */
function subjectFromHash() {
  const q = location.hash.split("?")[1] ?? "";
  return new URLSearchParams(q).get("about") === "progress" ? "progress" : "report";
}

/* A progression summary, built only from stored measurements. Every figure
   here came off a video; none is computed for effect. */
function summarise(rows) {
  const knee = (r) => r?.report?.kneeBendBDC?.value ?? r?.report?.kneeBendBDC?.mean;
  const measured = rows.filter((r) => knee(r) != null);
  if (!measured.length) return null;
  const first = measured[0], last = measured.at(-1);
  const when = (r) => new Date(r.created_at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return {
    sessions: rows.length,
    span: measured.length > 1 ? `${when(first)} to ${when(last)}` : when(last),
    kneeFirst: +knee(first).toFixed(1),
    kneeLast: +knee(last).toFixed(1),
    kneeChange: measured.length > 1 ? +(knee(last) - knee(first)).toFixed(1) : null,
    cadenceLast: last.cadence_rpm != null ? Math.round(last.cadence_rpm) : null,
    latestFix: last.report?.fix?.title ?? null,
    history: measured.map((r) => ({ on: when(r), knee: +knee(r).toFixed(1) })),
  };
}

export async function renderCoach(view) {
  const about = subjectFromHash();

  const { data: rows } = await supa
    .from("cycling_sessions")
    .select("created_at, cadence_rpm, report")
    .order("created_at", { ascending: true })
    .limit(30);
  const sessions = rows ?? [];

  const report = sessions.at(-1)?.report ?? null;
  const progress = summarise(sessions);

  // What the model is allowed to quote, and what the preview voice reads.
  const subject = about === "progress"
    ? { kind: "progress", progress }
    : { kind: "report", report };

  view.innerHTML = `
  ${appbar(about === "progress" ? "progress" : "this ride")}
  <div class="coach">
    <div class="orb" id="orb" data-mode="idle">
      <i class="ring r3"></i><i class="ring r2"></i><i class="ring r1"></i><i class="core"></i>
    </div>
    <div class="coach-state mono" id="cstate">Tap to talk</div>
    <p class="coach-line" id="cline">${openingLine(about, report, progress)}</p>
    <div class="coach-controls">
      <button class="ghost" id="cstop" disabled>End</button>
      <button class="mic" id="cmic" aria-label="Talk to your coach"><span></span></button>
      <button class="ghost" id="ctext">Read it</button>
    </div>
    <div class="coach-note mono" id="cnote">Connects when you tap</div>
    <audio id="cout" autoplay></audio>
  </div>`;

  const $ = (q) => view.querySelector(q);
  const orb = $("#orb"), cstate = $("#cstate"), cline = $("#cline"), cnote = $("#cnote");
  const mic = $("#cmic"), stop = $("#cstop"), out = $("#cout");

  let live = null;            // { pc, micStream }
  let audioCtx = null, raf = null, previewing = false;
  let localAn = null, remoteAn = null;

  const setAmp = (v) => orb.style.setProperty("--amp", Math.min(1, v).toFixed(3));
  const setState = (mode, label) => {
    orb.dataset.mode = mode;
    cstate.textContent = label;
    stop.disabled = mode === "idle";
    mic.classList.toggle("on", mode === "listening" || mode === "live");
  };

  /* Everything the preview voice can say, assembled from the report. No
     sentence here introduces a figure the analysis did not produce. */
  function script() {
    if (about === "progress") {
      if (!progress) return ["You haven't filmed a ride yet. Film one and I'll have something to compare against."];
      if (progress.sessions === 1)
        return ["This is your first analysis, so there's nothing to compare it with yet.",
                `Your knee bent ${progress.kneeLast} degrees at the bottom. Film again after any change to the bike and I'll tell you which way it moved.`];
      const dir = progress.kneeChange > 0 ? "more" : "less";
      return [
        `You've filmed ${progress.sessions} analyses, ${progress.span}.`,
        `Your knee bend at the bottom went from ${progress.kneeFirst} degrees to ${progress.kneeLast}. That's ${Math.abs(progress.kneeChange)} degrees ${dir} bend.`,
        progress.latestFix ? `The latest fix is still ${progress.latestFix}.` : "",
      ].filter(Boolean);
    }
    if (!report) return ["You haven't filmed a ride yet. Film the side view and I'll have something to tell you."];
    if (report.gate) return ["I couldn't trust the last read.", report.gate];
    const lines = [`Here's the one thing from this ride. ${report.fix.title}.`, report.fix.line, `Try this. ${report.fix.cue}`];
    const knee = report.cards?.find((c) => c.name?.startsWith("Knee at"));
    if (knee) lines.push(`For reference, that knee measured ${knee.value} across ${report.strokes} strokes.`);
    if (report.front?.asymmetry >= 1.35)
      lines.push(`From the front, your ${report.front.looser} knee travels ${report.front.asymmetry} times as far as the other.`);
    return lines;
  }

  function level(an, buf) {
    an.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) { const d = (v - 128) / 128; sum += d * d; }
    return Math.sqrt(sum / buf.length);
  }

  // One loop drives the orb from whichever side of the conversation is talking.
  function watch() {
    const lb = localAn && new Uint8Array(localAn.frequencyBinCount);
    const rb = remoteAn && new Uint8Array(remoteAn.frequencyBinCount);
    const loop = () => {
      if (!live) return;
      const me = localAn ? level(localAn, lb) : 0;
      const them = remoteAn ? level(remoteAn, rb) : 0;
      setAmp(Math.max(me, them) * 6);
      setState(them > me + 0.01 ? "speaking" : "listening", them > me + 0.01 ? "Coach" : "Listening");
      raf = requestAnimationFrame(loop);
    };
    loop();
  }

  async function goLive() {
    setState("thinking", "Connecting");
    cnote.textContent = "Connecting to the coach…";

    const { data } = await supa.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("Sign in to use the coach");

    const r = await fetch(COACH_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ report: subject }),
    });
    const payload = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(payload.error || `coach-token returned ${r.status}`);
    const { secret, model } = payload;
    if (!secret) throw new Error("coach-token returned no client secret");

    const pc = new RTCPeerConnection();
    const remote = new MediaStream();
    pc.ontrack = (e) => { remote.addTrack(e.track); out.srcObject = remote; };

    const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micStream.getTracks().forEach((t) => pc.addTrack(t, micStream));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const answer = await fetch(`${REALTIME_CALLS}?model=${encodeURIComponent(model || "gpt-realtime")}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/sdp" },
      body: offer.sdp,
    });
    if (!answer.ok) throw new Error(`realtime handshake ${answer.status}`);
    await pc.setRemoteDescription({ type: "answer", sdp: await answer.text() });

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    localAn = audioCtx.createAnalyser(); localAn.fftSize = 512;
    audioCtx.createMediaStreamSource(micStream).connect(localAn);
    remoteAn = audioCtx.createAnalyser(); remoteAn.fftSize = 512;
    audioCtx.createMediaStreamSource(remote).connect(remoteAn);

    live = { pc, micStream };
    cnote.textContent = "Live · OpenAI Realtime";
    cline.textContent = "I'm listening.";
    setState("listening", "Listening");
    watch();
  }

  // The preview voice: always available, never invents a number.
  function speakPreview(lines, why) {
    cnote.textContent = why ? `Preview voice — ${why}` : "Preview voice · on your phone";
    if (!window.speechSynthesis) { cline.textContent = lines.join(" "); return; }
    window.speechSynthesis.cancel();
    previewing = true;
    setState("speaking", "Coach");
    let t = 0;
    const envelope = () => {
      if (!previewing) return;
      t += 0.09;
      setAmp(0.45 + 0.3 * Math.abs(Math.sin(t)) + 0.12 * Math.abs(Math.sin(t * 2.7)));
      raf = requestAnimationFrame(envelope);
    };
    envelope();
    lines.forEach((line, i) => {
      const u = new SpeechSynthesisUtterance(line);
      u.rate = 1.02;
      u.onstart = () => { cline.textContent = line; };
      if (i === lines.length - 1) u.onend = () => end();
      window.speechSynthesis.speak(u);
    });
  }

  function end() {
    previewing = false;
    cancelAnimationFrame(raf);
    window.speechSynthesis?.cancel();
    live?.micStream.getTracks().forEach((t) => t.stop());
    live?.pc.close();
    live = null;
    localAn = remoteAn = null;
    out.srcObject = null;
    audioCtx?.close().catch(() => {}); audioCtx = null;
    setAmp(0.18);
    setState("idle", "Tap to talk");
  }

  mic.onclick = async () => {
    if (live || previewing) { end(); return; }
    try {
      await goLive();
    } catch (e) {
      // Never a dead end: fall back to the preview voice and say why.
      end();
      speakPreview(script(), e.message);
    }
  };

  $("#ctext").onclick = () => { if (!live && !previewing) speakPreview(script()); };
  stop.onclick = end;

  setAmp(0.18);
  setState("idle", "Tap to talk");
  return end;              // the router releases the mic when you navigate away
}

function openingLine(about, report, progress) {
  if (about === "progress") {
    return progress
      ? `I've got ${progress.sessions} of your analyses in front of me. Ask me how you're tracking.`
      : "No rides yet — film one and I'll have something to compare against.";
  }
  return report
    ? "I've read this ride. Tap and ask me anything about it."
    : "No ride to talk about yet — film one and I'll take you through it.";
}
