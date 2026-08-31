import { supa } from "../supa.js";

import { pool, comparable, kneeReadOf, standing as standing_ } from "../analysis.js";
import { appbar } from "../ui.js";

export async function renderHome(view, user) {
  const { data: sessions } = await supa
    .from("cycling_sessions")
    .select("id, created_at, cadence_rpm, report")
    .order("created_at", { ascending: true })
    .limit(30);

  const latest = sessions?.at(-1);
  const knee = (s) => s?.report?.kneeBendBDC?.value ?? s?.report?.kneeBendBDC?.mean;

  /* Home answers "so where am I?", so it pools every ride rather than
     repeating the newest one's headline. One ride can sit a degree from the
     edge and mean nothing; five that all sit there mean that is where this
     rider rides.

     What those rides ADD UP TO is decided in analysis.js and nowhere else.
     Home used to work it out again from the same numbers and arrive somewhere
     different — telling a rider "that is where you ride, not a shaky reading"
     while the report two taps away said the readings could not all be right. */
  const reads = (sessions ?? []).map((s) => kneeReadOf(s.report)).filter(Boolean);
  const across = pool(comparable(reads));
  const standing = standing_(reads);

  view.innerHTML = `
  ${appbar(new Date().toLocaleDateString(undefined,{day:"numeric",month:"short"}))}
  ${latest ? `
    <h1>Your riding, over time</h1>
    <div class="glass card">
      <div class="row"><h3>Where you stand</h3></div>
      <p><strong>${standing?.head ?? "Nothing measured yet"}</strong></p>
      <p>${standing?.line ?? ""}</p>
    </div>
    <div class="glass card">
      <div class="row"><h3>Knee bend at the bottom</h3>
        <div class="val">${across ? across.value.toFixed(0) : "–"}° <em>${standing?.word ?? "–"}</em></div></div>
      ${/* Not the sentence above, again. This card owns the chart, so it says
            what the chart is — and nothing the card above already said. */""}
      <p>One bar per ride, oldest on the left. A taller bar is more bend in the
      knee at the bottom of the stroke, which usually means a lower saddle.</p>
      <div class="spark">${(sessions ?? []).map((s,i)=>{
        const v = knee(s); const h = v ? Math.max(8, Math.min(100, (v-20)*3)) : 8;
        return `<i style="height:${h}%" class="${i===sessions.length-1?"last":""}"></i>`;}).join("")}
      </div>
    </div>
    <div class="glass card">
      <div class="row"><h3>Sessions</h3><div class="val">${sessions.length}</div></div>
      <p>Cadence last time: ${latest.cadence_rpm ? latest.cadence_rpm.toFixed(0)+" rpm" : "–"}. Film from the same spot each time, so one ride can be compared with the next.</p>
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
