import { appbar } from "../ui.js";

export function renderLocked(view, title, text) {
  view.innerHTML = `
  ${appbar()}
  <div class="glass locked card">
    <div class="padlock">🔒</div>
    <h2>${title}</h2>
    <p>${text}</p>
  </div>`;
}
