/* Every measured number has to arrive with the frame it was taken from, in the
   card that claims it. This was asked for repeatedly and kept getting built as
   one video at the top of the report instead. */
import { browser, BASE, T, finish } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2 });
await page.goto(`${BASE}/#/login`);
await page.waitForSelector('#send');

const r = await page.evaluate(async () => {
  const { drawReport } = await import('/js/pages/analyze.js');
  const A = await import('/js/analysis.js');

  // a tall portrait frame, like a phone shoots
  const c = document.createElement('canvas'); c.width = 540; c.height = 960;
  const x = c.getContext('2d');
  x.fillStyle = '#b8b3aa'; x.fillRect(0, 0, 540, 960);
  x.fillStyle = '#3a3a3a'; x.fillRect(150, 380, 240, 300);
  const full = c.toDataURL('image/jpeg', 0.85);

  // crop() is not exported; exercise it through the same geometry it uses
  const shot = (caption) => ({ src: full, drawn: true, caption });
  const cards = [
    { name: "Knee at 6 o'clock", value: '29°', verdict: 'Watch', note: 'Band 30–40°.',
      shot: shot('Knee 31° on this stroke.') },
    { name: "Foot at 6 o'clock", value: '18° toe-down', verdict: 'OK', note: 'Band 5–20°.',
      shot: shot('Your foot at the bottom of this stroke.') },
    { name: 'Cadence', value: '85 rpm', verdict: 'OK', note: 'Sweet spot 75–95.' },
  ];
  drawReport(document.getElementById('view'), {
    viewsCaptured: ['side'], strokes: 14, cadence: 85, trim: [0, 20],
    keyframes: [shot('a')], stillsFail: null,
    fix: { title: 'Saddle looks high', line: 'l', cue: 'c', why: 'A leg that straightens too far makes you reach for the pedal.' },
    cards,
  }, null);
  await new Promise((res) => setTimeout(res, 400));

  /* The frame now lives behind the card's toggle, so it has to be opened
     before it exists on screen. A lazy image inside a hidden panel never
     loads at all — decode() on one simply never resolves, which is how this
     suite came to hang rather than fail. */
  for (const head of document.querySelectorAll('.mhead')) head.click();
  await new Promise((res) => setTimeout(res, 300));

  const figs = [...document.querySelectorAll('.card .cardshot')];
  const imgs = figs.map((f) => f.querySelector('img'));
  const withShot = [...document.querySelectorAll('.card')].filter((el) => el.querySelector('.cardshot'));
  const cadenceCard = [...document.querySelectorAll('.card')].find((el) => /Cadence/.test(el.textContent));

  return {
    figs: figs.length,
    everyShotInsideItsCard: withShot.every((el) => /Knee at 6|Foot at 6/.test(el.querySelector('h3').textContent)),
    captioned: figs.every((f) => f.querySelector('figcaption')?.textContent.trim().length > 10),
    fitsWidth: imgs.every((i) => i.clientWidth > 0 && i.clientWidth <= i.parentElement.clientWidth + 1),
    noShotWithoutMeasurement: !cadenceCard?.querySelector('.cardshot'),
    whyShown: !!document.querySelector('.why'),
    whyText: document.querySelector('.why')?.textContent.slice(0, 40),
    noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
    // a card's still must be a real image, not a broken one
    // Bounded: a decode that never settles is a failure, not a reason to hang.
    loaded: await Promise.all(imgs.map((i) => Promise.race([
      i.decode().then(() => true, () => false),
      new Promise((res) => setTimeout(() => res(false), 5000)),
    ]))),
  };
});

T('every measurement card carries its own frame', r.figs === 2, `${r.figs} stills in cards`);
T('and the frame sits inside the card that claims the number', r.everyShotInsideItsCard);
T('each one says what it is showing', r.captioned);
T('a card with no measured frame gets no picture', r.noShotWithoutMeasurement, 'cadence has no still');
T('stills fit their card', r.fitsWidth);
T('the images actually decode', r.loaded.every(Boolean), JSON.stringify(r.loaded));
T('the fix says what the change would get you', r.whyShown, `"${r.whyText}…"`);
T('no horizontal overflow', r.noOverflow);
await b.close();
finish();
