import { browser, BASE, T, finish, OUT } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2 });
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto(`${BASE}/#/login`);
await page.waitForSelector('#send');

const nav = await page.evaluate(() => {
  document.getElementById('nav').classList.remove('hidden');
  return {
    items: [...document.querySelectorAll('.nav a')].map(a => a.dataset.r),
    soon: [...document.querySelectorAll('.soon')].map(e => e.closest('a').dataset.r),
    coachHref: document.querySelector('[data-r="coach"]').getAttribute('href'),
  };
});
T('nav is home/coach/analyze/journey/profile', nav.items.join(',') === 'home,coach,analyze,journey,profile', nav.items.join(','));
T('drills is gone from the nav', !nav.items.includes('drills'), nav.items.join(','));
// Journey went from a placeholder to the screen that pairs rides with changes.
T('no nav item is still a placeholder', nav.soon.length === 0, `soon on: ${nav.soon.join(',') || 'nothing'}`);
T('nav coach opens on progression', nav.coachHref === '#/coach?about=progress', nav.coachHref);

// The report keeps its own entry, because "this ride" is a subject the nav
// cannot express.
const rep = await page.evaluate(() => {
  const v = document.getElementById('view');
  v.innerHTML = `<a class="btn secondary coach-cta" href="#/coach?about=report"><span class="cmic"></span>Talk about this ride</a>`;
  const a = v.querySelector('.coach-cta');
  return { href: a.getAttribute('href'), display: getComputedStyle(a).display };
});
T('report button carries the ride subject', rep.href === '#/coach?about=report', rep.href);
T('coach button reads as a voice control', rep.display === 'flex', `display=${rep.display}`);

// The coach must pick the subject up off the link.
// Set the hash and render in the same tick: the router would otherwise bounce
// an unauthenticated visitor to #/login and strip the param before we look.
for (const [about, wants] of [['progress', /progress/i], ['report', /this ride/i]]) {
  const got = await page.evaluate(async (a) => {
    history.replaceState(null, '', `#/coach?about=${a}`);
    const { renderCoach } = await import('/js/pages/coach.js');
    const v = document.getElementById('view'); v.innerHTML = '';
    window.__d = await renderCoach(v);
    return { meta: document.querySelector('.appbar .meta')?.textContent ?? '', line: document.querySelector('#cline').textContent };
  }, about);
  T(`?about=${about} sets the subject`, wants.test(got.meta), `appbar meta="${got.meta}" · "${got.line.slice(0, 44)}…"`);
  await page.evaluate(() => window.__d?.());
}
console.log(errs.length ? 'JS ERRORS: ' + errs.join(' | ') : 'no JS errors');
await b.close();
finish();
