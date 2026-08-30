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
  /* This is the first screen anyone opens, so it is the one that has to make
     sense with no run-up. It used to read: "You ride at the top edge — 15
     rides, all between 27° and 39°, against a band of 30–40°. You ride just
     over it, consistently." Three separate faults in one sentence: "band" is
     our word and not a rider's, 27 to 39 against 30 to 40 is not "just over"
     anything, and the whole line was printed again word for word in the card
     below it.

     Which edge, correctly. The old test asked whether the value was below the
     bottom of the range — but a rider sitting exactly ON the bottom fails that
     test and was told they ride at the TOP. Compare against the middle of the
     range instead, which is what "nearer this end" actually means.

     Less bend means the leg is straightening further, which is a saddle
     slightly too high; more bend is one slightly too low. */
  const rides = across ? `${across.rides} ride${across.rides > 1 ? "s" : ""}` : "";
  const deg = across ? across.value.toFixed(0) : "";
  const nearLow = across ? across.value < (kLo + kHi) / 2 : false;

  const standing = !across ? null
    : acrossVerdict === "ok"
      ? { word: "OK",
          head: "Your saddle height looks right",
          line: `Your knee bends ${deg}° at the bottom of the stroke, across ${rides}. Riders sit between ${kLo}° and ${kHi}°, so you are comfortably inside that.` }
    : across.settled && acrossVerdict === "borderline"
      ? { word: "At edge",
          head: nearLow ? "You ride at the straight-leg end" : "You ride at the bent-leg end",
          line: `Your knee bends ${deg}° at the bottom of the stroke, and riders sit between ${kLo}° and ${kHi}°. You are right at the ${nearLow ? "straighter" : "more bent"} end of that, ride after ride — so it is where you ride, not a shaky reading.` }
    : acrossVerdict === "borderline"
      ? { word: "Not settled",
          head: "Not enough agreement yet",
          line: `Your rides do not line up closely enough for us to call this — ${across.rides} of ${SETTLE_RIDES} so far. Film one more from the same spot and we should be able to.` }
      : { word: "Watch",
          head: nearLow ? "Your saddle looks a little high" : "Your saddle looks a little low",
          line: `Your knee bends ${deg}° at the bottom of the stroke, across ${rides}, where riders sit between ${kLo}° and ${kHi}°. ${nearLow ? "Your leg is straightening further than it wants to, which is what a saddle a touch too high feels like." : "Your leg never quite opens out, which is what a saddle a touch too low feels like."}` };

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
