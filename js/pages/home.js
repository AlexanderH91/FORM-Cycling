import { supa } from "../supa.js";
import { BANDS } from "../config.js";
import { appbar } from "../ui.js";

export async function renderHome(view, user) {
  const { data: sessions } = await supa
    .from("cycling_sessions")
    .select("id, created_at, cadence_rpm, report")
    .order("created_at", { ascending: true })
    .limit(30);

  const latest = sessions?.at(-1);
  const knee = (s) => s?.report?.kneeBendBDC?.mean;

  view.innerHTML = `
  ${appbar(new Date().toLocaleDateString(undefined,{day:"numeric",month:"short"}))}
  ${latest ? `
    <h1>Your riding, over time</h1>
    <div class="glass card">
      <div class="row"><h3>Latest fix</h3></div>
      <p><strong>${latest.report?.fix?.title ?? "Analysis complete"}</strong> — ${latest.report?.fix?.line ?? "open the session for details"}.</p>
    </div>
    <div class="glass card">
      <div class="row"><h3>Knee bend at the bottom</h3>
        <div class="val">${knee(latest)?.toFixed(0) ?? "–"}° <em>${inBand(knee(latest), BANDS.kneeBendBDC)}</em></div></div>
      <p>Band ${BANDS.kneeBendBDC[0]}–${BANDS.kneeBendBDC[1]}° while riding. Each bar is one analysis.</p>
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

function inBand(v, [lo, hi]) {
  if (v == null) return "–";
  return v >= lo && v <= hi ? "OK" : "Watch";
}
