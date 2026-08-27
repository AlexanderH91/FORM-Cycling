import { browser, BASE, T, finish, OUT } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const c = await b.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, permissions: ['microphone'] });
const page = await c.newPage();
const errs = []; page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
await page.goto(`${BASE}/#/coach?about=progress`);
await page.waitForSelector('#send');
await page.evaluate(async () => {
  document.getElementById('nav').classList.remove('hidden');
  document.querySelector('[data-r="coach"]')?.classList.add('on');
  const { renderCoach } = await import('/js/pages/coach.js');
  const v = document.getElementById('view'); v.innerHTML = '';
  window.__dispose = await renderCoach(v);
});
await page.waitForSelector('#cmic');
await page.waitForTimeout(500);

const idle = await page.evaluate(() => ({
  mode: document.querySelector('#orb').dataset.mode,
  state: document.querySelector('#cstate').textContent,
  note: document.querySelector('.coach-note').textContent,
  navHasCoach: !!document.querySelector('[data-r="coach"]'),
  navHasJourney: !!document.querySelector('[data-r="journey"]'),
}));
T('Coach and Journey both sit on the nav', idle.navHasCoach && idle.navHasJourney, `coach=${idle.navHasCoach} journey=${idle.navHasJourney}`);
T('starts idle', idle.mode === 'idle' && /tap to talk/i.test(idle.state), `${idle.mode} · "${idle.state}"`);
T('idle note does not overclaim', /connects when you tap/i.test(idle.note), `"${idle.note.trim()}"`);
await page.screenshot({ path: OUT + 'coach-idle.png' });

// No signed-in user and no reachable endpoint here, so tapping must degrade
// to the preview voice and SAY why, rather than dying.
await page.click('#cmic');
await page.waitForTimeout(2500);
const fell = await page.evaluate(() => ({
  mode: document.querySelector('#orb').dataset.mode,
  note: document.querySelector('#cnote').textContent,
  line: document.querySelector('#cline').textContent,
}));
T('falls back to the preview voice when live fails', /preview voice/i.test(fell.note), `note="${fell.note.trim()}"`);
T('the fallback names its reason', /preview voice — .+/i.test(fell.note.trim()), `note="${fell.note.trim()}"`);
T('still says something useful', fell.line.length > 10, `"${fell.line.slice(0,56)}…"`);
await page.screenshot({ path: OUT + 'coach-fallback.png' });

// The read-aloud path must work with no network at all.
await page.evaluate(() => document.querySelector('#cstop').click());
await page.waitForTimeout(300);
await page.click('#ctext');
await page.waitForTimeout(900);
const read = await page.evaluate(() => ({ mode: document.querySelector('#orb').dataset.mode, note: document.querySelector('#cnote').textContent }));
T('Read it works offline', ['speaking','idle'].includes(read.mode), `mode=${read.mode} note="${read.note.trim()}"`);

await page.evaluate(() => window.__dispose?.());
await page.waitForTimeout(300);
const released = await page.evaluate(() => !document.querySelector('#orb').dataset.mode || document.querySelector('#orb').dataset.mode === 'idle');
T('mic released on teardown', released, `mode back to idle=${released}`);
console.log(errs.length ? 'JS ERRORS: ' + errs.join(' | ') : 'no JS errors');
await b.close();
finish();
