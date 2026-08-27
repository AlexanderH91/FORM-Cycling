import { supa } from "../supa.js";
import { appbar } from "../ui.js";
import { BUILD, VERSION } from "../config.js";

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
  <button class="btn secondary" id="signout">Sign out</button>
  <div class="footnote">${VERSION} · build ${BUILD}<br>Videos are analyzed on your phone and never uploaded. Only measurement results are stored in your account.</div>`;

  view.querySelector("#save").onclick = async () => {
    const h = +view.querySelector("#height").value;
    localStorage.setItem("form_height_cm", h || "");
    view.querySelector("#msg").textContent = "Saved — used from your next analysis.";
  };
  view.querySelector("#signout").onclick = () => supa.auth.signOut();
}
