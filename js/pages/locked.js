export function renderLocked(view, title, text) {
  view.innerHTML = `
  <div class="appbar"><div class="brand">FORM <span>Cycling</span></div></div>
  <div class="glass locked card">
    <div class="padlock">🔒</div>
    <h2>${title}</h2>
    <p>${text}</p>
  </div>`;
}
