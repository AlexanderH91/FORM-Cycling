import { supa } from "../supa.js";
import { SESSION_TABLE } from "../config.js";
import { appbar } from "../ui.js";

export async function renderProfile(view, user) {
  const height = localStorage.getItem("form_height_cm") ?? "";

  view.innerHTML = `
  ${appbar()}
  <h1>Profile</h1>
  <div class="glass card">
    <h3>Account</h3>
    <p class="mono" style="font-size:14px">${user.email}</p>
    <p>One FORM account — Golf, Cycling and Running share it.</p>
  </div>
  <div class="glass card">
    <h3>Height</h3>
    <p>Not needed for anything FORM measures today: every number in your report is scaled against your own body, so it needs no tape measure. Kept for stride length, which needs a real distance.</p>
    <label>Height (cm)</label>
    <input id="height" type="number" inputmode="numeric" min="120" max="220" value="${height}">
    <div class="ok" id="msg"></div>
    <button class="btn secondary" id="save">Save</button>
  </div>
  <button class="btn secondary" id="signout">Sign out</button>
  <div class="footnote">Videos are analyzed on your phone and never uploaded. Only measurement results are stored in your account (table: ${SESSION_TABLE}).</div>`;

  view.querySelector("#save").onclick = () => {
    const h = +view.querySelector("#height").value;
    localStorage.setItem("form_height_cm", h || "");
    view.querySelector("#msg").textContent = "Saved on this phone.";
  };
  view.querySelector("#signout").onclick = () => supa.auth.signOut();
}
