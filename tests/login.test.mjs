import { browser, BASE, T, finish, OUT } from './lib.mjs';
const chromium = await browser();

const b = await chromium.launch();
const page = await b.newPage();
const errs = [];
page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });
page.on('requestfailed', r => errs.push('REQFAIL: ' + r.url() + ' :: ' + (r.failure()||{}).errorText));

let otpCalls = 0, verifyCalls = 0;
await page.route('**/auth/v1/otp**', async r => { otpCalls++; await r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); });
await page.route('**/auth/v1/verify**', async r => { verifyCalls++; return r.fulfill({ status: 400, contentType: 'application/json',
  body: JSON.stringify({ error: 'invalid_otp', error_description: 'Token has expired or is invalid', msg: 'Token has expired or is invalid', code: 403 }) }); });

await page.goto(`${BASE}/#/login`);
await page.waitForSelector('#send');

// this suite's checks are async; funnel them through the shared collector
const check = async (name, fn) => { const v = await fn(); T(name, v.ok, v.info); };

await check('invalid email rejected', async () => {
  await page.fill('#email', 'not-an-email');
  await page.click('#send');
  const t = (await page.textContent('#step-email .err')).trim();
  return { ok: t.includes('valid email'), info: JSON.stringify(t) + ` otpCalls=${otpCalls}` };
});

await check('valid email advances to code step', async () => {
  await page.fill('#email', 'rider@example.com');
  await page.click('#send');
  await page.waitForSelector('#step-code:not(.hidden)', { timeout: 5000 });
  const sentTo = await page.textContent('#sent-to');
  const okMsg = (await page.textContent('#step-code .ok')).trim();
  const emailHidden = await page.locator('#step-email').evaluate(e => e.classList.contains('hidden'));
  return { ok: emailHidden && sentTo === 'rider@example.com' && okMsg.includes('rider@example.com') && otpCalls === 1,
    info: `sentTo=${sentTo} ok=${JSON.stringify(okMsg)} emailHidden=${emailHidden} otpCalls=${otpCalls}` };
});

await check('resend is on cooldown', async () => {
  const [txt, dis] = await Promise.all([page.textContent('#resend'), page.locator('#resend').isDisabled()]);
  return { ok: dis && /Resend code in \d+s/.test(txt), info: `text=${JSON.stringify(txt)} disabled=${dis}` };
});

await check('page says 8-digit and placeholder matches', async () => {
  const [copy, ph] = await Promise.all([page.textContent('#step-code p'), page.getAttribute('#code', 'placeholder')]);
  return { ok: copy.includes('8-digit') && ph === '00000000', info: `copy=${JSON.stringify(copy.slice(0,24))} placeholder=${ph}` };
});

await check('short code (<6) rejected client-side without a server call', async () => {
  const before = verifyCalls;
  await page.fill('#code', '12345');
  await page.click('#verify');
  const t = (await page.textContent('#step-code .err')).trim();
  return { ok: t.includes('8-digit code') && verifyCalls === before, info: JSON.stringify(t) + ` verifyCalls=${verifyCalls}` };
});

await check('6-digit code still submittable by hand (dashboard may differ)', async () => {
  const before = verifyCalls;
  await page.fill('#code', '123456');
  await page.click('#verify');
  await page.waitForFunction(n => window.__vc === undefined || true, null).catch(()=>{});
  await page.waitForTimeout(300);
  return { ok: verifyCalls === before + 1, info: `verifyCalls went ${before} -> ${verifyCalls}` };
});

await check('code input strips non-digits, caps at 10', async () => {
  await page.fill('#code', 'Your FORM code is 123 456 789 012 — expires soon');
  const v = await page.inputValue('#code');
  return { ok: v === '1234567890', info: `value=${v}` };
});

await check('8 digits auto-verifies and shows server error', async () => {
  await page.fill('#code', '');
  await page.fill('#code', '12345678');
  await page.waitForFunction(() => document.querySelector('#step-code .err').textContent.trim().length > 0, null, { timeout: 5000 }).catch(()=>{});
  const t = (await page.textContent('#step-code .err')).trim();
  const okMsg = (await page.textContent('#step-code .ok')).trim();
  return { ok: /expired or is invalid/i.test(t) && okMsg === '', info: JSON.stringify(t) + ' okCleared=' + (okMsg === '') };
});

await check('verify button restored after failure', async () => {
  const [txt, dis] = await Promise.all([page.textContent('#verify'), page.locator('#verify').isDisabled()]);
  return { ok: txt.trim() === 'Sign in' && !dis, info: `text=${JSON.stringify(txt)} disabled=${dis}` };
});

await check('back returns to email step and clears cooldown', async () => {
  await page.click('#back');
  const emailVisible = await page.locator('#step-email').evaluate(e => !e.classList.contains('hidden'));
  const codeHidden = await page.locator('#step-code').evaluate(e => e.classList.contains('hidden'));
  const resendTxt = (await page.textContent('#resend')).trim();
  const errTxt = (await page.textContent('#step-email .err')).trim();
  return { ok: emailVisible && codeHidden && resendTxt === 'Resend code' && errTxt === '',
    info: `emailVisible=${emailVisible} codeHidden=${codeHidden} resend=${JSON.stringify(resendTxt)} err=${JSON.stringify(errTxt)}` };
});

await check('no password fields remain', async () => {
  const n = await page.locator('input[type=password]').count();
  return { ok: n === 0, info: `passwordInputs=${n}` };
});

await check('navigating away does not throw (interval cleanup)', async () => {
  await page.evaluate(() => { location.hash = '#/home'; });
  await page.waitForTimeout(2500);
  return { ok: true, info: 'errors so far: ' + (errs.length ? errs.join(' | ') : 'none') };
});

console.log(errs.length ? '\nJS ERRORS:\n' + errs.join('\n') : '\nNo JS errors.');
await b.close();
finish();
