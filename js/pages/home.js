import { supa } from "../supa.js";
import { BANDS, SESSION_TABLE } from "../config.js";
import { appbar } from "../ui.js";

export async function renderHome(view, user) {
  const { data: sessions } = await supa
    .from(SESSION_TABLE)
    .select("id, created_at, cadence_spm, report")
    .order("created_at", { ascending: true })
    .limit(30);

  const latest = sessions?.at(-1);
  const spm = (s) => {
    const v = s?.report?.cadenceSpm?.value ?? s?.cadence_spm;
    return v == null || Number.isNaN(Number(v)) ? null : Number(v);
  };
  const [lo, hi] = BANDS.cadenceSpm;

  view.innerHTML = `
  ${appbar(new Date().toLocaleDateString(undefined,{day:"numeric",month:"short"}))}
  ${latest ? `
    <h1>Your running, over time</h1>
    <div class="glass card">
      <div class="row"><h3>Latest fix</h3></div>
      <p><strong>${latest.report?.fix?.title ?? "Analysis complete"}</strong> — ${latest.report?.fix?.line ?? "open the session for details"}</p>
    </div>
    <div class="glass card">
      <div class="row"><h3>Cadence</h3>
        <div class="val">${spm(latest)?.toFixed(0) ?? "–"} spm ${verdictChip(latest)}</div></div>
      <p>Window ${lo}–${hi} steps a minute. Each bar is one analysis.</p>
      <div class="spark">${(sessions ?? []).map((s,i)=>{
        const v = spm(s); const h = v ? Math.max(8, Math.min(100, (v - 130) * 1.3)) : 8;
        return `<i style="height:${h}%" class="${i===sessions.length-1?"last":""}"></i>`;}).join("")}
      </div>
    </div>
    <div class="glass card">
      <div class="row"><h3>Sessions</h3><div class="val">${sessions.length}</div></div>
      <p>Trunk lean last time: ${latest.report?.trunkLean?.value != null ? latest.report.trunkLean.value.toFixed(0)+"° forward" : "–"}. Film in the same spot at the same pace each time — comparisons stay honest that way.</p>
    </div>`
  : `
    <h1>Ready for your first analysis</h1>
    <p>Three short clips — side, front, behind — and FORM gives you one honest fix, with every number shown on your own video.</p>
    <div class="glass card"><h3>How it works</h3>
      <p>1 · Prop your phone beside the treadmill and run at a steady pace.<br>
         2 · Mark the stretch where your rhythm is settled.<br>
         3 · Your phone analyzes it — nothing is uploaded, only the results are saved.</p>
    </div>`}
  <p style="margin-top:14px"><a class="btn" href="#/analyze">Start a new analysis</a></p>
  <div class="footnote">FORM never claims what it can't measure. Most of what a phone can see while you run has no research band behind it — those numbers are reported without a verdict, on purpose.</div>
  `;

  /* The verdict word comes from the analysis, not from re-deriving it here —
     two places computing the same judgement is how a screen ends up telling a
     runner two different things about one number. */
  function verdictChip(row) {
    const v = row?.report?.cadenceVerdict;
    if (row?.report?.provisional || !v) return "";
    if (v === "ok") return `<em class="ok">In band</em>`;
    if (v === "low") return `<em>Watch</em>`;
    if (v === "borderline") return `<em class="close">Close</em>`;
    return "";                                    // above the window: no claim
  }
}
