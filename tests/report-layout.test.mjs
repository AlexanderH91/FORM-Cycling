import { browser, BASE, T, finish, OUT } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2 });
await page.goto(`${BASE}/#/login`);
await page.waitForSelector('#send');


// Stand-in stills at a real phone-video aspect. Overlay geometry is NOT what
// this checks — only that the report shell lays the frames out correctly.
const shot = await page.evaluate(() => {
  const c = document.createElement('canvas'); c.width = 720; c.height = 405;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 720, 405);
  g.addColorStop(0, '#1a1d1a'); g.addColorStop(1, '#0e100e');
  x.fillStyle = g; x.fillRect(0, 0, 720, 405);
  x.strokeStyle = '#F2C230'; x.lineWidth = 4; x.lineJoin = 'round'; x.lineCap = 'round';
  x.beginPath(); x.moveTo(300, 150); x.lineTo(360, 250); x.lineTo(330, 330); x.stroke();
  x.fillStyle = 'rgba(11,11,11,.78)'; x.fillRect(378, 228, 74, 42);
  x.fillStyle = '#F2C230'; x.font = '600 32px Arial'; x.fillText('46°', 390, 259);
  return c.toDataURL('image/jpeg', 0.82);
});

await page.evaluate((src) => {
  document.getElementById('nav').classList.remove('hidden');
  const kf = [
    { src, label: "Bottom of the stroke · 6 o'clock", caption: 'Knee 46° on this stroke — the average across all 16 is 46°.' },
    { src, label: 'Top of the stroke', caption: 'Hip fold 29° on this stroke — the average is 29°.' },
  ];
  const cards = [
    ['Knee at 6 o’clock','46°','Watch','Band 30–40° while riding — this is the saddle-height check. ±5.2° across 16 strokes.'],
    ['Cadence','85 rpm','OK','Research sweet spot 75–95 rpm for experienced riders.'],
  ];
  document.getElementById('view').innerHTML = `
  <div class="appbar"><div class="brand">FORM <span>Cycling</span></div><div class="meta">new report</div></div>
  <div class="glass card" style="border-left:3px solid var(--gold)">
    <div class="sect" style="margin:0 0 6px">This ride's fix</div>
    <h2>Saddle looks low</h2><p>Your knee stays bent 46° at the bottom (band 30–40°).</p>
    <p><strong>Try:</strong> Raise the saddle 5 mm, ride a minute, film again.</p>
  </div>
  <div class="sect">What we measured on</div>
  ${kf.map(k => `<figure class="keyframe glass"><img src="${k.src}" alt="${k.label}">
    <figcaption><span class="kf-label">${k.label}</span>${k.caption}</figcaption></figure>`).join('')}
  <div class="sect">Measured</div>
  ${cards.map(c => `<div class="glass card"><div class="row"><h3>${c[0]}</h3>
    <div class="val">${c[1]} <em>${c[2]}</em></div></div><p>${c[3]}</p></div>`).join('')}
  <a class="btn" href="#/home">Done</a>
  <div class="footnote">Analyzed on your phone across 16 pedal strokes · video and these frames never leave the phone · front &amp; behind views ship in the next update</div>`;
}, shot);
await page.waitForTimeout(400);

const m = await page.evaluate(() => {
  const f = document.querySelector('.keyframe');
  const img = f.querySelector('img');
  const view = document.getElementById('view');
  return {
    imgW: img.getBoundingClientRect().width,
    figW: f.getBoundingClientRect().width,
    viewInner: view.clientWidth - 32,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    capColor: getComputedStyle(f.querySelector('.kf-label')).color,
    count: document.querySelectorAll('.keyframe').length,
    border: parseFloat(getComputedStyle(f).borderLeftWidth),
  };
});
T('two keyframes render', m.count === 2, `count=${m.count}`);
T('image fills the card content box', Math.abs(m.imgW - (m.figW - 2 * m.border)) < 0.6,
  `img=${m.imgW.toFixed(1)} fig=${m.figW.toFixed(1)} border=${m.border}px each side`);
T('no horizontal overflow', !m.overflowX, `overflowX=${m.overflowX}`);
T('label uses the gold token', m.capColor === 'rgb(242, 194, 48)', `color=${m.capColor}`);

await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: OUT + 'report-keyframes.png', fullPage: false });
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.waitForTimeout(200);
const tail = await page.evaluate(() => {
  const nav = document.getElementById('nav').getBoundingClientRect();
  const fn = document.querySelector('.footnote').getBoundingClientRect();
  return { gap: nav.top - fn.bottom };
});
T('footnote clears the nav', tail.gap > 0, `gap=${tail.gap.toFixed(1)}px`);
await page.screenshot({ path: OUT + 'report-tail.png' });
await b.close();
finish();
