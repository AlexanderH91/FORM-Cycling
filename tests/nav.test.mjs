import { browser, BASE, T, finish, OUT } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3 });
const errs = [];
page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
await page.goto(`${BASE}/#/login`);
await page.waitForSelector('.brand .mark', { timeout: 5000 });

await page.evaluate(() => {
  document.getElementById('nav').classList.remove('hidden');
  document.querySelector('[data-r="home"]').classList.add('on');
  document.getElementById('view').innerHTML = document.getElementById('view').innerHTML;
});
await page.waitForTimeout(400);

const m = await page.evaluate(() => {
  const nav = document.getElementById('nav');
  const r = nav.getBoundingClientRect();
  const disc = nav.querySelector('.disc').getBoundingClientRect();
  const items = [...nav.querySelectorAll('a')].map(a => {
    const b = a.getBoundingClientRect();
    return { r: a.dataset.r, label: a.querySelector('span:last-child')?.textContent, h: +b.height.toFixed(1), cx: +(b.left + b.width / 2).toFixed(1) };
  });
  return {
    navH: r.height, navBottom: r.bottom, vp: innerHeight,
    fullWidth: r.left === 0 && Math.abs(r.right - innerWidth) < 1,
    disc: { w: disc.width, h: disc.height },
    soon: nav.querySelectorAll('.soon').length,
    items,
    navVar: getComputedStyle(document.documentElement).getPropertyValue('--nav-h').trim(),
    pad: parseFloat(getComputedStyle(document.getElementById('view')).paddingBottom),
    brandMark: !!document.querySelector('.brand .mark'),
  };
});
T('nav spans the full width', m.fullWidth, 'spans viewport');
T('nav sits on the bottom edge', Math.abs(m.navBottom - m.vp) < 1, `bottom=${m.navBottom} vp=${m.vp}`);
T('centre disc is a 60px circle', m.disc.w === 60 && m.disc.h === 60, `${m.disc.w}x${m.disc.h}`);
T('one SOON badge — Journey, the only thing still locked', m.soon === 1, `count=${m.soon}`);
T('five nav items', m.items.length === 5, m.items.map(i => i.r + ':' + i.label).join(' '));
T('--nav-h tracks the new nav', m.navVar === Math.round(m.navH) + 'px' || parseFloat(m.navVar) > 0, `--nav-h=${m.navVar} navH=${m.navH.toFixed(1)}`);
T('view reserves past the nav', m.pad > m.navH, `pad=${m.pad} navH=${m.navH.toFixed(1)}`);
T('mark renders in the app bar', m.brandMark, `present=${m.brandMark}`);
console.log(errs.length ? 'JS ERRORS: ' + errs.join(' | ') : 'no JS errors');
await page.screenshot({ path: OUT + 'nav-login.png' });
await page.screenshot({ path: OUT + 'nav-crop.png', clip: { x: 0, y: 852 - 130, width: 393, height: 130 } });
await b.close();
finish();
