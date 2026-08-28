import { supa } from "../supa.js";
import { appbar, sheet } from "../ui.js";
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
    <p>FORM measures how you sit on the bike. Your head unit knows how you
    actually rode. Connect one and every change you make gets a before and an
    after.</p>
    <div class="ok" id="linkmsg"></div>
    <div class="err" id="linkerr"></div>
    <div class="providers" id="providers"></div>
    <div id="links"></div>
    <input type="file" accept=".tcx,.xml,application/xml,text/xml" class="hidden" id="tcx">
  </div>
  <button class="btn secondary" id="signout">Sign out</button>
  <div class="footnote">${VERSION} · build ${BUILD}<br>Videos are analyzed on your phone and never uploaded. Only measurement results are stored in your account.</div>`;

  /* ---- training platform links ---- */
  const PROVIDERS = {
    strava: {
      name: "Strava", initial: "S", colour: "#FC4C02",
      what: "Rides pull in automatically after each one",
    },
    garmin: {
      name: "Garmin", initial: "G", colour: "#4B9CD3",
      what: "Import a file, or let Garmin sync to Strava",
    },
  };

  function providerButton(key, chip, chipClass = "") {
    const p = PROVIDERS[key];
    return `<button class="provider" data-p="${key}">
      <span class="pmark" style="background:${p.colour}">${p.initial}</span>
      <span><span class="pname">${p.name}</span><span class="pwhat">${p.what}</span></span>
      <span class="pchip ${chipClass}">${chip}</span>
    </button>`;
  }

  /* Pressing a provider explains what is about to happen before it happens.
     The rider is being sent to another company's site; being told what comes
     back — and what FORM keeps — is the least they are owed. */
  function stravaSheet(live) {
    const s = sheet(`
      <h2>Connect Strava</h2>
      ${live ? "" : `<p class="pchip off" style="display:inline-block;margin:0 0 10px">Preview · not switched on yet</p>`}
      <p>Every ride you upload to Strava arrives here on its own, so a saddle
      change stops being a guess and starts having a before and an after.</p>
      <ol class="howsteps">
        <li><b>Strava asks your permission.</b> You will land on Strava's own
        page — FORM never sees your Strava password.</li>
        <li><b>You come straight back.</b> Your recent rides are pulled in
        within a few seconds.</li>
        <li><b>Journey fills in.</b> Each change you log gets the rides either
        side of it, with the count on each side shown.</li>
      </ol>
      <p class="sheetnote"><strong>What FORM keeps:</strong> date, duration,
      power, heart rate and cadence. <strong>What it never asks for:</strong>
      your routes or GPS. It cannot post to Strava, and disconnecting deletes
      every ride it brought in.</p>
      <button class="btn" id="sheetgo" style="margin-top:18px">${
        live ? "Continue to Strava" : "Continue to Strava"}</button>
      ${live ? "" : `<p class="dim" style="font-size:12.5px;margin-top:10px">
        This will work as soon as the Strava keys are set on the server. Until
        then this button shows you the shape of it.</p>`}`);

    s.el.querySelector("#sheetgo").onclick = async (e) => {
      e.target.disabled = true;
      e.target.textContent = "Opening Strava…";
      try {
        const res = await startStrava();
        if (res.ok) return;                        // the browser is leaving
        e.target.disabled = false;
        e.target.textContent = "Continue to Strava";
        say(linkmsg, "");
        say(linkerr, res.message);
        s.close();
      } catch (err) {
        e.target.disabled = false;
        e.target.textContent = "Continue to Strava";
        say(linkerr, err.message);
        s.close();
      }
    };
  }

  function garminSheet() {
    const s = sheet(`
      <h2>Garmin</h2>
      <p class="pchip off" style="display:inline-block;margin:0 0 10px">Not connectable</p>
      <p>${GARMIN_STATUS.reason} FORM would rather say that than give you a
      button that can only fail.</p>
      <p style="color:var(--ink)"><strong>Two things that do work today:</strong></p>
      <ol class="howsteps">
        <li><b>Let Garmin feed Strava.</b> Nearly every Garmin already syncs
        there automatically — connect Strava and your Garmin rides arrive with
        everything else.</li>
        <li><b>Import a file.</b> Export a <b>.TCX</b> from Garmin Connect and
        open it here. It is read on your phone; nothing is uploaded.</li>
      </ol>
      <p class="sheetnote">The moment Garmin reopens its developer programme,
      this becomes a direct connection — the app is already built for it.</p>
      <button class="btn" id="sheetstrava" style="margin-top:18px">Connect Strava instead</button>
      <button class="btn secondary" id="sheetfile" style="margin-top:10px">Import a .TCX file</button>`);

    s.el.querySelector("#sheetstrava").onclick = () => { s.close(); stravaSheet(false); };
    s.el.querySelector("#sheetfile").onclick = () => { s.close(); view.querySelector("#tcx").click(); };
  }

  const linkmsg = view.querySelector("#linkmsg"), linkerr = view.querySelector("#linkerr");
  const say = (el, text) => { el.textContent = text; };

  async function paintLinks() {
    let s;
    try { s = await linkStatus(); }
    catch (e) { say(linkerr, "Could not read your connections: " + e.message); return; }
    const strava = s.links.find((l) => l.provider === "strava");

    view.querySelector("#providers").innerHTML =
      providerButton("strava", strava ? "Connected" : "Connect", strava ? "live" : "") +
      providerButton("garmin", "How to", "");
    for (const btn of view.querySelectorAll(".provider")) {
      btn.onclick = () => (btn.dataset.p === "garmin" ? garminSheet() : strava ? null : stravaSheet(false));
    }

    view.querySelector("#links").innerHTML = strava
      ? `<div class="linkrow"><div><b>Strava</b><br><span class="dim">${
          s.rides} ride${s.rides === 1 ? "" : "s"} on file${
          strava.last_sync_at ? ` · last checked ${new Date(strava.last_sync_at).toLocaleDateString()}` : ""}${
          strava.last_error ? ` · last attempt: ${strava.last_error}` : ""}</span></div></div>
         <button class="btn secondary" id="sync">Check for new rides</button>
         <button class="btn ghostbtn" id="unlink">Disconnect Strava</button>`
      : "";

    const on = (id, fn) => { const el = view.querySelector("#" + id); if (el) el.onclick = fn; };
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
