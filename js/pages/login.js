import { supa } from "../supa.js";
import { OTP_LENGTH } from "../config.js";
import { appbar } from "../ui.js";

const RESEND_COOLDOWN_S = 60;
// Supabase allows an OTP of 6–10 digits. OTP_LENGTH is what this project is set
// to; MIN/MAX keep a mismatched dashboard setting from locking anyone out.
const CODE_LENGTH = OTP_LENGTH;
const CODE_MIN = 6;
const CODE_MAX = 10;
const A_CODE = `${CODE_LENGTH === 8 ? "an" : "a"} ${CODE_LENGTH}-digit`;

export function renderLogin(view) {
  view.innerHTML = `
  ${appbar()}
  <h1>One camera.<br>One honest fix.</h1>
  <p>Prop your phone beside the treadmill and run. FORM measures how you carry yourself and how you land — averaged over every stride — and coaches one change at a time. Same account as FORM Golf and FORM Cycling.</p>

  <div class="glass card">
    <h3>Sign in</h3>

    <div id="step-email">
      <p>Enter your email and we'll send you ${A_CODE} code. No password to remember.</p>
      <label>Email</label>
      <input id="email" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com">
      <div class="err"></div><div class="ok"></div>
      <button class="btn" id="send">Email me a code</button>
    </div>

    <div id="step-code" class="hidden">
      <p>We sent ${A_CODE} code to <strong id="sent-to"></strong>. It expires in a few minutes.</p>
      <label>Code</label>
      <input id="code" type="text" autocomplete="one-time-code" inputmode="numeric"
             pattern="[0-9]*" placeholder="${"0".repeat(CODE_LENGTH)}">
      <div class="err"></div><div class="ok"></div>
      <button class="btn" id="verify">Sign in</button>
      <button class="btn secondary" id="resend">Resend code</button>
      <button class="btn secondary" id="back">Use a different email</button>
    </div>
  </div>

  <div class="sect">Before your first analysis</div>
  <div class="glass card"><h3>1 · Side view</h3><p>Phone at hip height, 2–3 m out to the side, your whole body in frame. This is the view we measure — cadence, trunk and how you land all come from it.</p></div>
  <div class="glass card"><h3>2 · Front view</h3><p>Phone at hip height in front of the treadmill, straight on. This view watches your knees swing in and out.</p></div>
  <div class="glass card"><h3>3 · From behind</h3><p>Phone behind the treadmill, light from the side — never a window straight behind you. This view watches shoulders and hips.</p></div>
  <div class="footnote">Run at a steady, settled pace for the part you want measured. FORM needs a stretch of even rhythm, not a warm-up or a sprint finish.</div>
  `;

  const $ = (sel) => view.querySelector(sel);
  const stepEmail = $("#step-email");
  const stepCode = $("#step-code");
  const emailInput = $("#email");
  const codeInput = $("#code");
  const sendBtn = $("#send");
  const verifyBtn = $("#verify");
  const resendBtn = $("#resend");
  const backBtn = $("#back");
  const errs = view.querySelectorAll(".err");
  const oks = view.querySelectorAll(".ok");

  let email = "";
  let busy = false;
  let cooldownTimer = null;

  // Both steps carry their own message slot; only one step is on screen at a time.
  const say = (msg = "", good = false) => {
    errs.forEach(el => { el.textContent = good ? "" : msg; });
    oks.forEach(el => { el.textContent = good ? msg : ""; });
  };

  const setBusy = (on, btn, label) => {
    busy = on;
    sendBtn.disabled = on;
    verifyBtn.disabled = on;
    resendBtn.disabled = on || cooldownTimer !== null;
    if (btn) btn.textContent = on ? label : btn.dataset.label;
  };

  [sendBtn, verifyBtn, resendBtn].forEach(b => { b.dataset.label = b.textContent; });

  function startCooldown() {
    let left = RESEND_COOLDOWN_S;
    const tick = () => {
      // The router wipes the view on navigation — stop ticking against dead nodes.
      if (!view.contains(resendBtn)) { clearInterval(cooldownTimer); cooldownTimer = null; return; }
      if (left <= 0) {
        clearInterval(cooldownTimer);
        cooldownTimer = null;
        resendBtn.disabled = busy;
        resendBtn.textContent = resendBtn.dataset.label;
        return;
      }
      resendBtn.textContent = `Resend code in ${left}s`;
      left -= 1;
    };
    clearInterval(cooldownTimer);
    resendBtn.disabled = true;
    cooldownTimer = setInterval(tick, 1000);
    tick();
  }

  async function sendCode(btn, label) {
    if (busy) return;
    const value = emailInput.value.trim();
    const target = email || value;
    if (!/^\S+@\S+\.\S+$/.test(target)) { say("Enter a valid email address."); return; }
    say();
    setBusy(true, btn, label);
    const { error } = await supa.auth.signInWithOtp({
      email: target,
      options: { shouldCreateUser: true },
    });
    setBusy(false, btn, label);
    if (error) { say(error.message); return; }
    email = target;
    $("#sent-to").textContent = email;
    stepEmail.classList.add("hidden");
    stepCode.classList.remove("hidden");
    say(`Code sent to ${email}.`, true);
    codeInput.value = "";
    codeInput.focus();
    startCooldown();
  }

  async function verifyCode() {
    if (busy) return;
    const token = codeInput.value.replace(/\D/g, "");
    if (token.length < CODE_MIN) { say(`Enter the ${CODE_LENGTH}-digit code from your email.`); return; }
    say();
    setBusy(true, verifyBtn, "Checking…");
    const { error } = await supa.auth.verifyOtp({ email, token, type: "email" });
    setBusy(false, verifyBtn, "Checking…");
    // On success onAuthStateChange re-routes to Home; nothing more to do here.
    if (error) { say(error.message); codeInput.select(); }
  }

  sendBtn.onclick = () => sendCode(sendBtn, "Sending…");
  resendBtn.onclick = () => sendCode(resendBtn, "Sending…");
  verifyBtn.onclick = verifyCode;

  backBtn.onclick = () => {
    clearInterval(cooldownTimer);
    cooldownTimer = null;
    resendBtn.textContent = resendBtn.dataset.label;
    email = "";
    stepCode.classList.add("hidden");
    stepEmail.classList.remove("hidden");
    say();
    emailInput.focus();
  };

  emailInput.onkeydown = (e) => { if (e.key === "Enter") sendCode(sendBtn, "Sending…"); };

  codeInput.oninput = () => {
    const digits = codeInput.value.replace(/\D/g, "").slice(0, CODE_MAX);
    if (digits !== codeInput.value) codeInput.value = digits;
    // Auto-submit at the configured length; longer codes still go by hand.
    if (digits.length === CODE_LENGTH) verifyCode();
  };
  codeInput.onkeydown = (e) => { if (e.key === "Enter") verifyCode(); };
}
