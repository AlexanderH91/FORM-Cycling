/* Every report this app has produced says "side only" — not because the rider
   chose side only, but because nothing ever asked for the next angle. The
   front view is the one that sees a knee tracking in or out, and it was being
   offered as a grey word under a button. */
import { browser, BASE, T, finish } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const c = await b.newContext({ viewport: { width: 393, height: 852 }, permissions: ['camera'] });
const page = await c.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
// #/analyze is behind auth, so render the capture screen directly — this
// suite is about the flow, not the router.
await page.goto(`${BASE}/#/login`);
await page.waitForSelector('#send');
await page.evaluate(async () => {
  document.getElementById('nav').classList.remove('hidden');
  const { renderAnalyze } = await import('/js/pages/analyze.js');
  const v = document.getElementById('view');
  v.innerHTML = '';
  window.__dispose = renderAnalyze(v, { id: 'u1' });
});
await page.waitForSelector('#shoot');
await page.waitForTimeout(1200);

const before = await page.evaluate(() => ({
  progress: document.getElementById('progress').textContent,
  states: [...document.querySelectorAll('.angle .astate')].map((e) => e.textContent),
  nextHidden: document.getElementById('next').classList.contains('hidden'),
  go: document.getElementById('go').textContent,
}));
T('with nothing filmed it says what filming all three gets you',
  /all three/i.test(before.progress), `"${before.progress}"`);
T('no angle claims to be optional', !before.states.some((s) => /optional|required/i.test(s)),
  before.states.join(' · '));
T('nothing is suggested before there is anything to suggest from', before.nextHidden);

// Film the side view.
await page.click('#shoot');
await page.waitForTimeout(1600);
await page.click('#shoot');
await page.waitForFunction(() => !document.getElementById('trim').classList.contains('hidden'), null, { timeout: 12000 });
await page.waitForTimeout(600);

const after = await page.evaluate(() => {
  const next = document.getElementById('next');
  return {
    progress: document.getElementById('progress').textContent,
    sideState: document.querySelector('.angle[data-a="side"] .astate').textContent,
    nextShown: !next.classList.contains('hidden'),
    nextTitle: next.querySelector('h3')?.textContent,
    nextWhy: next.querySelector('p')?.textContent,
    nextHow: next.querySelector('.nexthow')?.textContent,
    nextBtn: next.querySelector('[data-goto]')?.textContent,
    goto: next.querySelector('[data-goto]')?.dataset.goto,
    goEnabled: !document.getElementById('go').disabled,
  };
});
T('progress counts what is filmed', /1 of 3/.test(after.progress), `"${after.progress}"`);
T('a filmed angle is ticked, with its length', /✓/.test(after.sideState), `"${after.sideState}"`);
T('the next angle is asked for by name', after.nextShown && after.nextTitle === 'Front view',
  `"${after.nextTitle}"`);
T('it says what that angle measures', /knees track in or out/.test(after.nextWhy ?? ''), after.nextWhy);
T('and where to stand the phone for it',
  /knee height/.test(after.nextHow ?? '') && /front wheel/.test(after.nextHow ?? ''),
  after.nextHow);
T('with a button that goes straight there', after.nextBtn === 'Film the front view' && after.goto === 'front',
  `"${after.nextBtn}"`);
T('analysing what you already have is still allowed', after.goEnabled);

// Tapping it must return to the camera, not show the side clip again.
await page.click('[data-goto="front"]');
await page.waitForTimeout(500);
const switched = await page.evaluate(() => ({
  onFront: document.querySelector('.angle[data-a="front"]').classList.contains('on'),
  camShown: !document.getElementById('cam').classList.contains('hidden'),
  reviewHidden: document.getElementById('play').classList.contains('hidden'),
  hint: document.getElementById('hint').textContent,
}));
T('it puts you back behind the lens, not on the last take',
  switched.onFront && switched.camShown && switched.reviewHidden,
  `front=${switched.onFront} cam=${switched.camShown} review hidden=${switched.reviewHidden}`);
T('with that angle\'s framing instruction on screen',
  /knee height/.test(switched.hint) && /front wheel/.test(switched.hint), switched.hint);
T('no page errors', errs.length === 0, errs.join(' | ') || 'clean');
await b.close();
finish();
