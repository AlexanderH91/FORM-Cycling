import { browser, BASE, T, finish, OUT } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 393, height: 852 } });
await page.goto(`${BASE}/#/login`);
await page.waitForSelector('#send');
await page.evaluate(() => {
  document.getElementById('nav').classList.remove('hidden');
  document.querySelector('[data-r="analyze"]').classList.add('on');
});
await page.waitForTimeout(300);
const s = await page.evaluate(() => {
  const disc = document.querySelector('.nav .disc');
  const mark = disc.querySelector('.mark');
  const arc  = mark.querySelector('path:not(.burst):not(.cog)');
  const burst= mark.querySelector('.burst');
  const cog  = mark.querySelector('.cog');
  const cs = getComputedStyle(mark);
  return {
    discBg: getComputedStyle(disc).backgroundColor,
    markColor: cs.color,
    arcStroke: getComputedStyle(arc).stroke,
    burstFill: getComputedStyle(burst).fill,
    cogFill: getComputedStyle(cog).fill,
    cogRule: getComputedStyle(cog).fillRule,
    label: getComputedStyle(disc.querySelector('.disclbl')).color,
  };
});
T('disc background is gold', s.discBg === 'rgb(242, 194, 48)', s.discBg);
T('arc is black on the disc', s.arcStroke === 'rgb(11, 11, 11)', s.arcStroke);
T('burst drops out on the gold ground', s.burstFill === 'rgba(0, 0, 0, 0)' || s.burstFill === 'transparent', s.burstFill);
T('gear is black', s.cogFill === 'rgb(11, 11, 11)', s.cogFill);
T('gear hub is a punched hole', s.cogRule === 'evenodd', s.cogRule);
T('FORM label is black', s.label === 'rgb(11, 11, 11)', s.label);
await b.close();
finish();
