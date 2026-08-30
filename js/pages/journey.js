/* Journey: what you changed on the bike, and what your riding did afterwards.
 *
 * The honest shape of this screen is a timeline with a running commentary, not
 * a scoreboard. FORM knows when you changed something because you told it, and
 * knows how you rode because Strava told it. It does not know why your power
 * moved, and this screen is written so that it never pretends to. */
import { supa } from "../supa.js";
import { appbar } from "../ui.js";
import { aroundChange } from "../rides.js";
import { linkStatus } from "./connect.js";

const day = (t) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const fmt = (v, unit) => (unit === "W/bpm" ? v.toFixed(2) : v.toFixed(unit === "rpm" ? 0 : 0));

function shiftRow(s) {
  if (!s.enough)
    return `<div class="jrow"><span>${s.name}</span>
      <b class="dim">needs ${s.short}</b></div>`;
  const sign = s.delta > 0 ? "+" : "";
  const dir = s.clear ? (s.delta > 0 ? "up" : "down") : "flat";
  return `<div class="jrow"><span>${s.name}</span>
    <b class="${dir}">${fmt(s.beforeValue, s.unit)} → ${fmt(s.afterValue, s.unit)} ${s.unit}
      <em>${s.clear ? `${sign}${fmt(s.delta, s.unit)}` : "no clear change"}</em></b></div>
    <div class="jsub">${s.before} rides before, ${s.after} after${
      s.clear ? "" : ` · the change is smaller than the difference between your own rides, so it could be either way`}</div>`;
}

export async function renderJourney(view, user) {
  view.innerHTML = `${appbar()}<h1>Journey</h1><p>Loading your rides…</p>`;

  const [{ data: changes }, { data: rides }, status] = await Promise.all([
    supa.from("fit_changes").select("*").order("changed_at", { ascending: false }),
    supa.from("rides").select("*").order("start_time", { ascending: false }).limit(400),
    linkStatus().catch(() => ({ links: [], rides: 0 })),
  ]);

  const connected = (status.links ?? []).some((l) => l.provider !== "file");
  const hasRides = (rides ?? []).length > 0;

  const timeline = (changes ?? []).map((c) => {
    const a = aroundChange(rides ?? [], c);
    return `
    <div class="glass card">
      <div class="sect" style="margin:0 0 4px">${day(c.changed_at)}</div>
      <h3>${c.part}${c.direction ? ` ${c.direction}` : ""}${c.amount ? ` ${c.amount}` : ""}</h3>
      ${c.note ? `<p>${c.note}</p>` : ""}
      ${a.counts.before + a.counts.after === 0
        ? `<p class="dim">No indoor rides of 20 minutes or more within six weeks either side of this change, so there is nothing to compare yet.</p>`
        : `${a.shifts.map(shiftRow).join("")}
           <details class="caveats"><summary>What else could explain this</summary>
             <ul>${a.confounds.map((x) => `<li>${x}</li>`).join("")}</ul></details>`}
    </div>`;
  }).join("");

  view.innerHTML = `
  ${appbar()}
  <h1>Journey</h1>
  ${!connected ? `
    <div class="glass card">
      <h3>Connect your rides</h3>
      <p>FORM can measure your position, but it cannot see what happened next.
      Connect Strava — or import a file — and every change you make to the bike
      gets a before and an after.</p>
      <a class="btn" href="#/profile">Connect on the Me screen</a>
    </div>` : ""}

  ${changes?.length ? `<div class="sect">Changes you have made</div>${timeline}` : `
    <div class="glass card">
      <h3>No changes logged yet</h3>
      <p>When a report tells you to move something and you actually move it,
      tap <strong>I made this change</strong> on that report. That date is what
      splits your rides into a before and an after — without it, this screen is
      just a fitness chart.</p>
      <a class="btn secondary" href="#/analyze">Film a ride</a>
    </div>`}

  ${hasRides ? `
    <div class="sect">Rides pulled in</div>
    <div class="glass card">
      <div class="row"><h3>Rides on file</h3><div class="val">${rides.length}</div></div>
      <p>Newest ${day(rides[0].start_time)}. Summary figures only — FORM stores
      how you rode, never where.</p>
    </div>` : ""}

  <div class="footnote">FORM shows what happened alongside a change, not what
  the change caused. Power and heart rate move with fitness, sleep, heat and
  how hard you felt like riding, and none of that is visible here.</div>`;
}
