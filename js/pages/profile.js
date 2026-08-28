import { supa } from "../supa.js";
import { appbar } from "../ui.js";
import { BUILD, VERSION, GARMIN_STATUS } from "../config.js";
import { linkStatus, returnMessage, startStrava, syncStrava, disconnectStrava, importFile } from "./connect.js";

export async function renderProfile(view, user) {
  const { data: rows } = await supa.from("cycling_sessions")
    .select("rider_height_cm").not("rider_height_cm", "is", null)
    .order("created_at", { ascending: false }).limit(1);
  const height = rows?.[0]?.rider_height_cm ?? "";

  view.innerHTML = `
  ${appbar()}
  <h1>Profile</h1>
  <div class="glass card">
    <h3>Account</h3>
    <p class="mono" style="font-size:14px">${user.email}</p>
    <p>One FORM account — Golf and Cycling share it.</p>
  </div>
  <div class="glass card">
    <h3>Height</h3>
    <p>Lets reports speak in centimeters, not just degrees.</p>
    <label>Height (cm)</label>
    <input id="height" type="number" inputmode="numeric" min="120" max="220" value="${height}">
    <div class="ok" id="msg"></div>
    <button class="btn secondary" id="save">Save</button>
  </div>
  <div class="glass card">
    <h3>Your rides</h3>
    <p>Connect a training platform and FORM can show what your riding did after
    each change you make to the bike. Summary figures only — never your routes.</p>
    <div class="ok" id="linkmsg"></div>
    <div class="err" id="linkerr"></div>
    <div id="links"></div>
    <label style="margin-top:14px">Garmin</label>
    <p class="dim" style="font-size:13.5px">${GARMIN_STATUS.reason} Two things that
    do work today: almost every Garmin auto-syncs to Strava, or export a
    <strong>.TCX</strong> from Garmin Connect and import it here.</p>
    <button class="btn secondary" id="importbtn">Import a .TCX file</button>
    <input type="file" accept=".tcx,.xml,application/xml,text/xml" class="hidden" id="tcx">
  </div>
  <button class="btn secondary" id="signout">Sign out</button>
  <div class="footnote">${VERSION} · build ${BUILD}<br>Videos are analyzed on your phone and never uploaded. Only measurement results are stored in your account.</div>`;

  /* ---- training platform links ---- */
  const linkmsg = view.querySelector("#linkmsg"), linkerr = view.querySelector("#linkerr");
  const say = (el, text) => { el.textContent = text; };

  async function paintLinks() {
    let s;
    try { s = await linkStatus(); }
    catch (e) { say(linkerr, "Could not read your connections: " + e.message); return; }
    const strava = s.links.find((l) => l.provider === "strava");
    view.querySelector("#links").innerHTML = strava
      ? `<div class="linkrow"><div><b>Strava</b><br><span class="dim">${
          s.rides} ride${s.rides === 1 ? "" : "s"} on file${
          strava.last_sync_at ? ` · last checked ${new Date(strava.last_sync_at).toLocaleDateString()}` : ""}${
          strava.last_error ? ` · last attempt: ${strava.last_error}` : ""}</span></div></div>
         <button class="btn secondary" id="sync">Check for new rides</button>
         <button class="btn ghostbtn" id="unlink">Disconnect Strava</button>`
      : `<button class="btn" id="link">Connect Strava</button>`;

    const on = (id, fn) => { const el = view.querySelector("#" + id); if (el) el.onclick = fn; };
    on("link", async (e) => {
      e.target.disabled = true; say(linkerr, ""); say(linkmsg, "Opening Strava…");
      try { await startStrava(); }
      catch (err) { e.target.disabled = false; say(linkmsg, ""); say(linkerr, err.message); }
    });
    on("sync", async (e) => {
      e.target.disabled = true; say(linkerr, ""); say(linkmsg, "Asking Strava for new rides…");
      try {
        const { added } = await syncStrava();
        say(linkmsg, added ? `Added ${added} ride${added === 1 ? "" : "s"}.` : "No new rides since last time.");
      } catch (err) { say(linkmsg, ""); say(linkerr, err.message); }
      e.target.disabled = false;
      paintLinks();
    });
    on("unlink", async (e) => {
      e.target.disabled = true;
      say(linkmsg, ""); say(linkerr, "");
      try { await disconnectStrava(); say(linkmsg, "Disconnected, and the rides it brought in have been deleted."); }
      catch (err) { say(linkerr, err.message); }
      paintLinks();
    });
  }

  // Coming back from Strava's approval screen.
  const back = returnMessage();
  if (back) {
    say(back.kind === "err" ? linkerr : linkmsg, back.text);
    if (back.key === "connected") syncStrava().then(paintLinks).catch((e) => say(linkerr, e.message));
  }
  paintLinks();

  view.querySelector("#importbtn").onclick = () => view.querySelector("#tcx").click();
  view.querySelector("#tcx").onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    say(linkerr, ""); say(linkmsg, "Reading that file on your phone…");
    try {
      const ride = await importFile(file, user.id);
      say(linkmsg, `Imported your ride from ${new Date(ride.start_time).toLocaleDateString()}.`);
    } catch (err) { say(linkmsg, ""); say(linkerr, "Could not import that file — " + err.message); }
    e.target.value = "";
    paintLinks();
  };

  view.querySelector("#save").onclick = async () => {
    const h = +view.querySelector("#height").value;
    localStorage.setItem("form_height_cm", h || "");
    view.querySelector("#msg").textContent = "Saved — used from your next analysis.";
  };
  view.querySelector("#signout").onclick = () => supa.auth.signOut();
}
