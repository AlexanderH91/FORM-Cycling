import { supa } from "../supa.js";
import { BANDS, SETTLE_RIDES } from "../config.js";
import { pool, verdictWith, kneeReadOf } from "../analysis.js";
import { appbar } from "../ui.js";

export async function renderHome(view, user) {
  const { data: sessions } = await supa
    .from("cycling_sessions")
    .select("id, created_at, cadence_rpm, report")
    .order("created_at", { ascending: true })
    .limit(30);

  const latest = sessions?.at(-1);
  const knee = (s) => s?.report?.kneeBendBDC?.value ?? s?.report?.kneeBendBDC?.mean;

  /* Home is the screen that gets to answer "so where am I?", so it pools every
     ride rather than repeating the newest one's headline. A single ride can sit
     a degree from the band edge and mean nothing; five rides that all sit there
     mean that is where this rider rides. */
  const reads = (sessions ?? []).map((s) => kneeReadOf(s.report)).filter(Boolean);
  const across = pool(reads);
  const [kLo, kHi] = BANDS.kneeBendBDC;
  const acrossVerdict = across ? verdictWith(across.value, across.u, BANDS.kneeBendBDC) : null;
  const standing = !across ? null
    : acrossVerdict === "ok"
      ? { word: "OK", line: `Your knee bends ${across.value.toFixed(0)}° at the bottom across ${across.rides} ride${across.rides > 1 ? "s" : ""} — inside the ${kLo}–${kHi}° band.` }
    : across.settled && acrossVerdict === "borderline"
      ? { word: "At edge", line: `${across.rides} rides, all between ${across.lo.toFixed(0)}° and ${across.hi.toFixed(0)}°, against a band of ${kLo}–${kHi}°. You ride just ${across.value < kLo ? "under" : "over"} it, consistently — that is a real position, not an unclear reading.` }
    : acrossVerdict === "borderline"
      ? { word: "Not settled", line: `${across.rides} of ${SETTLE_RIDES} rides. Your knee reads ${across.value.toFixed(0)}° ±${across.u.toFixed(1)}°, and the ${kLo}–${kHi}° band edge is inside that margin. One or two more rides in the same spot will settle it.` }
      : { word: "Watch", line: `Your knee bends ${across.value.toFixed(0)}° at the bottom across ${across.rides} ride${across.rides > 1 ? "s" : ""}, ${across.value < kLo ? "under" : "over"} the ${kLo}–${kHi}° band by more than the margin of error.` };

  view.innerHTML = `
  ${appbar(new Date().toLocaleDateString(undefined,{day:"numeric",month:"short"}))}
  ${latest ? `
    <h1>Your riding, over time</h1>
    <div class="glass card">
      <div class="row"><h3>Where you stand</h3></div>
      <p><strong>${standing?.word === "At edge" ? (across.value < kLo ? "You ride at the bottom edge" : "You ride at the top edge")
        : standing?.word === "OK" ? "Saddle height holds up"
        : standing?.word === "Not settled" ? "Not settled yet"
        : "Worth a change"}</strong> — ${standing?.line ?? ""}</p>
    </div>
    <div class="glass card">
      <div class="row"><h3>Knee bend at the bottom</h3>
        <div class="val">${across ? across.value.toFixed(0) : "–"}° <em>${standing?.word ?? "–"}</em></div></div>
      <p>${standing ? standing.line : `Band ${kLo}–${kHi}° while riding.`} Each bar is one analysis.</p>
      <div class="spark">${(sessions ?? []).map((s,i)=>{
        const v = knee(s); const h = v ? Math.max(8, Math.min(100, (v-20)*3)) : 8;
        return `<i style="height:${h}%" class="${i===sessions.length-1?"last":""}"></i>`;}).join("")}
      </div>
    </div>
    <div class="glass card">
      <div class="row"><h3>Sessions</h3><div class="val">${sessions.length}</div></div>
      <p>Cadence last time: ${latest.cadence_rpm ? latest.cadence_rpm.toFixed(0)+" rpm" : "–"}. Film in the same spot each time — comparisons stay honest that way.</p>
    </div>`
  : `
    <h1>Ready for your first analysis</h1>
    <p>Three short clips — side, front, behind — and FORM gives you one honest fix, with every number shown on your own video.</p>
    <div class="glass card"><h3>How it works</h3>
      <p>1 · Prop your phone and record while you ride (up to 10 minutes).<br>
         2 · Mark the part of the clip where you're pedaling steadily.<br>
         3 · Your phone analyzes it — nothing is uploaded, only the results are saved.</p>
    </div>`}
  <p style="margin-top:14px"><a class="btn" href="#/analyze">Start a new analysis</a></p>
  <div class="footnote">FORM never claims what it can't measure. Angles are averaged across every pedal stroke in your clip.</div>
  `;
}
