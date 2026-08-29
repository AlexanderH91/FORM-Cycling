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
  const arc  = mark.querySelector('path:not(.cog)');
  const cog  = mark.querySelector('.cog');
  const cs = getComputedStyle(mark);
  return {
    discBg: getComputedStyle(disc).backgroundColor,
    markColor: cs.color,
    arcStroke: getComputedStyle(arc).stroke,
    paths: mark.querySelectorAll('path').length,
    viewBox: mark.getAttribute('viewBox'),
    cogFill: getComputedStyle(cog).fill,
    cogRule: getComputedStyle(cog).fillRule,
    label: getComputedStyle(disc.querySelector('.disclbl')).color,
  };
});
T('disc background is gold', s.discBg === 'rgb(242, 194, 48)', s.discBg);
T('arc is black on the disc', s.arcStroke === 'rgb(11, 11, 11)', s.arcStroke);
/* The starburst is gone. It existed to float a black cog on a dark ground; a
   gold ring does that with one shape instead of two, and the icon on the home
   screen is now the same mark rather than a cousin of it. */
T('the mark is two shapes, arc and ring', s.paths === 2, `${s.paths} paths`);
T('and its viewBox is the ink, so the ring is never clipped',
  s.viewBox === '2.2 -4.5 43.8 50.8', s.viewBox);
T('gear is black', s.cogFill === 'rgb(11, 11, 11)', s.cogFill);
T('gear hub is a punched hole', s.cogRule === 'evenodd', s.cogRule);
T('FORM label is black', s.label === 'rgb(11, 11, 11)', s.label);

/* The home-screen icon and the mark inside the app have to be the same shape,
   or the thing you tapped and the thing that opened are different products.
   They live in three files — index.html inlines the nav's copy — and that is
   exactly how the nav kept the old starburst through this change. */
{
  const [icon, ui, html] = await Promise.all(
    ['assets/icon.svg', 'js/ui.js', 'index.html'].map(async (f) =>
      (await fetch(`${BASE}/${f}`)).text()));
  const arc = icon.match(/d="(M5\.5 43[^"]+)"/)?.[1];
  const ring = icon.match(/d="(M\d[^"]*Z)"\s+fill="#0B0B0B"\s+fill-rule/)?.[1];
  T('the icon has an arc and a ring', !!arc && !!ring, arc ?? 'no arc found');
  T('the in-app mark is the same geometry', ui.includes(arc) && ui.includes(ring));
  T('and so is the copy inlined in the nav', html.includes(arc) && html.includes(ring));
  /* The word belongs on the home-screen tile — it is asked for, and the tile
     is where the sport gets named. What it must not do is shrink the mark: the
     first version put a big bold word in the middle and left the arc half its
     size, which is what made the icon look amateur next to Golf's. */
  T('the icon names the sport', /<text[^>]*>cycling<\/text>/.test(icon));
  const scale = parseFloat(icon.match(/scale\(([\d.]+)\)/)?.[1] ?? '0');
  T('and the mark keeps its size anyway', scale > 1.3,
    `mark scaled ${scale} — the word costs it under a tenth of its height`);
  const font = parseFloat(icon.match(/font-size="([\d.]+)"/)?.[1] ?? '99');
  T('the word is a caption, not a partner', font < 13 && /font-weight="500"/.test(icon),
    `${font}px, weight 500`);
  T('the in-app mark carries no word — the nav already says FORM',
    !/<text/.test(ui) && !/<text/.test(html.slice(html.indexOf('class="disc"'), html.indexOf('</nav>'))));
  T('the starburst is gone everywhere', ![icon, ui, html].some((f) => /class="burst"/.test(f)));
}

await b.close();
finish();
