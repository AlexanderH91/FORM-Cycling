import { supa } from "../supa.js";

export function renderLogin(view) {
  view.innerHTML = `
  <div class="appbar"><div class="brand">FORM <span>Cycling</span></div></div>
  <h1>One camera.<br>One honest fix.</h1>
  <p>Film yourself on your trainer with the phone you already own. FORM measures how you sit and pedal — averaged over every stroke — and coaches one change at a time. Same account as FORM Golf.</p>

  <div class="glass card">
    <h3>Sign in</h3>
    <label>Email</label>
    <input id="email" type="email" autocomplete="email" placeholder="you@example.com">
    <label>Password</label>
    <input id="pw" type="password" autocomplete="current-password" placeholder="••••••••">
    <div class="err" id="err"></div>
    <button class="btn" id="signin">Sign in</button>
    <button class="btn secondary" id="signup">Create account</button>
  </div>

  <div class="sect">Before your first analysis</div>
  <div class="glass card"><h3>1 · Side view</h3><p>Phone at saddle height, 2–3 m away, whole bike and rider in frame. This view measures knee, hip, foot and your position.</p></div>
  <div class="glass card"><h3>2 · Front view</h3><p>Phone at bar height, straight ahead. This view watches your knees track up and down.</p></div>
  <div class="glass card"><h3>3 · From behind</h3><p>Phone behind the rear wheel, light from the side — never a window straight behind you. This view watches shoulders and pelvis.</p></div>
  `;
  const err = view.querySelector("#err");
  const creds = () => ({
    email: view.querySelector("#email").value.trim(),
    password: view.querySelector("#pw").value,
  });
  view.querySelector("#signin").onclick = async () => {
    err.textContent = "";
    const { error } = await supa.auth.signInWithPassword(creds());
    if (error) err.textContent = error.message;
  };
  view.querySelector("#signup").onclick = async () => {
    err.textContent = "";
    const { error } = await supa.auth.signUp(creds());
    if (error) err.textContent = error.message;
    else err.textContent = "Account created — check your email if confirmation is required.";
  };
}
