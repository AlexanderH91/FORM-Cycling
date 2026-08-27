import { browser, BASE, T, finish, OUT } from './lib.mjs';
const chromium = await browser();
// fake camera + mic so getUserMedia resolves with a real MediaStream
const b = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const ctxb = await b.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, permissions: ['camera'] });
const page = await ctxb.newPage();
const errs = [];
page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
await page.goto(`${BASE}/#/login`);
await page.waitForSelector('#send');
await page.evaluate(async () => {
  document.getElementById('nav').classList.remove('hidden');
  document.querySelector('[data-r="analyze"]').classList.add('on');
  const { renderAnalyze } = await import('/js/pages/analyze.js');
  const v = document.getElementById('view');
  v.innerHTML = '';
  window.__dispose = renderAnalyze(v, { id: 'u1' });
});
await page.waitForSelector('#shoot');
await page.waitForTimeout(1200);


const live = await page.evaluate(() => {
  const cam = document.querySelector('#cam');
  return { camVisible: !cam.classList.contains('hidden'), hasStream: !!cam.srcObject,
    tracks: cam.srcObject ? cam.srcObject.getTracks().length : 0,
    angles: [...document.querySelectorAll('.angle')].map(a => a.dataset.a + ':' + a.querySelector('.astate').textContent),
    on: document.querySelector('.angle.on')?.dataset.a,
    goText: document.querySelector('#go').textContent, goDisabled: document.querySelector('#go').disabled };
});
T('lands straight in the live camera', live.camVisible && live.hasStream && live.tracks > 0, `stream tracks=${live.tracks}`);
T('all three angles pickable in-session', live.angles.length === 3, live.angles.join(' | '));
T('side is the starting angle', live.on === 'side', `on=${live.on}`);
T('analyze gated until the side view exists', live.goDisabled && /side view/i.test(live.goText), `"${live.goText}"`);

// switch angle without leaving the session
await page.click('.angle[data-a="front"]');
const sw = await page.evaluate(() => ({ on: document.querySelector('.angle.on')?.dataset.a,
  hint: document.querySelector('#hint').textContent, camVisible: !document.querySelector('#cam').classList.contains('hidden') }));
T('switching angle keeps you in the lens', sw.on === 'front' && sw.camVisible, `on=${sw.on} · "${sw.hint.slice(0,34)}…"`);

// record a take against the current angle
await page.click('#shoot');
await page.waitForTimeout(2600);
const during = await page.evaluate(() => ({
  recording: document.querySelector('#shoot').classList.contains('recording'),
  pill: !document.querySelector('#recpill').classList.contains('hidden'),
  otherDisabled: document.querySelector('.angle[data-a="side"]').disabled }));
T('recording state is visible and locks the angle', during.recording && during.pill && during.otherDisabled,
  `recording=${during.recording} pill=${during.pill} otherLocked=${during.otherDisabled}`);
await page.click('#shoot');
await page.waitForTimeout(1200);
const after = await page.evaluate(() => ({
  filled: [...document.querySelectorAll('.angle.filled')].map(a => a.dataset.a),
  state: document.querySelector('.angle[data-a="front"] .astate').textContent,
  reviewing: !document.querySelector('#play').classList.contains('hidden'),
  trimVisible: !document.querySelector('#trim').classList.contains('hidden'),
  retakeOn: !document.querySelector('#retake').disabled }));
T('take lands on the chosen angle and opens for trim', after.filled.includes('front') && after.reviewing && after.trimVisible,
  `filled=${after.filled} trim=${after.trimVisible} retake=${after.retakeOn}`);

const dur = await page.evaluate(() => {
  const t = window.__peekTrim ? null : null;
  const chip = document.querySelector('.angle[data-a="front"] .astate').textContent;
  const v = document.querySelector('#play');
  return { chip, duration: v.duration, finite: Number.isFinite(v.duration) };
});
T('recorded clip resolves a real duration (not Infinity)', dur.finite && dur.duration > 0,
  `duration=${dur.duration} chip=${dur.chip}`);
T('trim length is non-zero', dur.chip !== '0:00' && dur.chip !== '…', `chip=${dur.chip}`);

const fits = await page.evaluate(() => {
  const navTop = document.getElementById('nav').getBoundingClientRect().top;
  const go = document.querySelector('#go').getBoundingClientRect();
  const sh = document.querySelector('#shoot').getBoundingClientRect();
  return { overflow: Math.max(0, document.documentElement.scrollHeight - innerHeight),
           goBottom: go.bottom, shutterBottom: sh.bottom, navTop };
});
T('shutter clears the nav without scrolling', fits.shutterBottom < fits.navTop,
  `shutter bottom=${fits.shutterBottom.toFixed(0)} navTop=${fits.navTop.toFixed(0)}`);
T('analyze button reachable without scrolling', fits.goBottom < fits.navTop,
  `go bottom=${fits.goBottom.toFixed(0)} navTop=${fits.navTop.toFixed(0)}`);
T('only the footnote falls below the fold', fits.overflow < 130, `overflow=${fits.overflow}px`);

// leaving must release the camera
await page.evaluate(() => window.__dispose());
await page.waitForTimeout(300);
const released = await page.evaluate(() => {
  const cam = document.querySelector('#cam');
  const s = cam && cam.srcObject;
  return s ? s.getTracks().every(t => t.readyState === 'ended') : true;
});
T('camera released on teardown', released, `all tracks ended=${released}`);
console.log(errs.length ? 'JS ERRORS: ' + errs.join(' | ') : 'no JS errors');
await b.close();
finish();
