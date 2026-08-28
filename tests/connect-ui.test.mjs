/* The two connect buttons and what pressing them shows. Strava's keys are not
   on the server yet, so this also pins the difference between "not set up"
   (explain what it will be like) and "broken" (a red error the rider did
   nothing to cause). */
import { browser, BASE, T, finish } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2 });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${BASE}/#/login`);
await page.waitForSelector('#send');

// Render Profile against a stubbed backend — this suite is about the UI.
await page.evaluate(async () => {
  const { supa } = await import('/js/supa.js');
  supa.from = () => {
    const chain = {
      select: () => chain, not: () => chain, order: () => chain, eq: () => chain,
      limit: async () => ({ data: [] }),
      then: (res) => res({ data: [], count: 0 }),
    };
    return chain;
  };
  const { renderProfile } = await import('/js/pages/profile.js');
  document.getElementById('nav').classList.remove('hidden');
  await renderProfile(document.getElementById('view'), { id: 'u1', email: 'rider@example.com' });
});
await page.waitForTimeout(300);

const buttons = await page.evaluate(() => {
  const bs = [...document.querySelectorAll('.provider')];
  return bs.map((el) => ({
    key: el.dataset.p,
    name: el.querySelector('.pname').textContent,
    what: el.querySelector('.pwhat').textContent.trim(),
    chip: el.querySelector('.pchip').textContent.trim(),
    tall: el.getBoundingClientRect().height,
    markColour: getComputedStyle(el.querySelector('.pmark')).backgroundColor,
  }));
});
T('both providers are offered as buttons', buttons.length === 2 && buttons.map((x) => x.key).join() === 'strava,garmin',
  buttons.map((x) => `${x.name}:${x.chip}`).join(' · '));
T('each says what it does without being tapped',
  buttons.every((x) => x.what.length > 15), buttons.map((x) => x.what).join(' | '));
T('touch targets are big enough to hit', buttons.every((x) => x.tall >= 44), buttons.map((x) => x.tall.toFixed(0)).join('/'));
T('each carries its own brand colour', buttons[0].markColour !== buttons[1].markColour,
  `${buttons[0].markColour} vs ${buttons[1].markColour}`);

// --- Strava sheet -----------------------------------------------------------
await page.click('[data-p="strava"]');
await page.waitForSelector('.sheetwrap.open .sheet');
await page.waitForTimeout(400);        // let it finish sliding up before measuring
const strava = await page.evaluate(() => {
  const s = document.querySelector('.sheet');
  const steps = [...s.querySelectorAll('.howsteps li')];
  const r = steps.map((li) => li.getBoundingClientRect());
  return {
    title: s.querySelector('h2').textContent,
    chip: s.querySelector('.pchip')?.textContent.trim(),
    steps: steps.length,
    // stacked, not laid out across the sheet
    stacked: r.every((box, i) => i === 0 || box.top > r[i - 1].top + 10),
    text: s.textContent,
    onScreen: s.getBoundingClientRect().bottom <= innerHeight + 1,
    cta: s.querySelector('#sheetgo')?.textContent.trim(),
  };
});
T('the Strava sheet says it is a preview, not a failure', /preview/i.test(strava.chip ?? ''), `chip="${strava.chip}"`);
T('it walks through what will happen', strava.steps === 3, `${strava.steps} steps`);
T('the steps read down the page, not across it', strava.stacked);
T('it says what FORM keeps and what it never asks for',
  /never asks for/.test(strava.text) && /routes/.test(strava.text));
T('it says disconnecting deletes the rides', /disconnecting deletes/.test(strava.text));
T('the primary action is there and named', strava.cta === 'Continue to Strava', `"${strava.cta}"`);
T('the sheet fits on screen', strava.onScreen);

// Pressing it with no keys set explains, rather than throwing a raw error.
await page.click('#sheetgo');
await page.waitForFunction(() => !document.querySelector('.sheetwrap'), null, { timeout: 8000 });
const after = await page.evaluate(() => ({
  err: document.getElementById('linkerr')?.textContent ?? '',
  stillOnProfile: !!document.querySelector('.provider'),
}));
/* Whichever it is — no keys on the server, or no way to reach the server —
   the rider gets a sentence they can act on rather than "Failed to fetch". */
T('a button that cannot work yet explains itself in plain words',
  /not switched on/i.test(after.err) || /reach the FORM server/i.test(after.err), `"${after.err}"`);
T('and leaves you where you were', after.stillOnProfile);

// --- Garmin sheet -----------------------------------------------------------
await page.click('[data-p="garmin"]');
await page.waitForSelector('.sheetwrap.open .sheet');
await page.waitForTimeout(400);
const garmin = await page.evaluate(() => {
  const s = document.querySelector('.sheet');
  return {
    chip: s.querySelector('.pchip')?.textContent.trim(),
    text: s.textContent,
    routes: s.querySelectorAll('.howsteps li').length,
    buttons: [...s.querySelectorAll('button.btn')].map((x) => x.textContent.trim()),
  };
});
T('Garmin is marked not connectable rather than hidden', /not connectable/i.test(garmin.chip ?? ''), `chip="${garmin.chip}"`);
T('and says why, in the rider\'s terms', /paused new developer applications/.test(garmin.text));
T('it offers the two routes that do work', garmin.routes === 2 && garmin.buttons.length === 2,
  garmin.buttons.join(' · '));
T('no page errors through any of it', errs.length === 0, errs.join(' | ') || 'clean');

// closing works
await page.click('.sheetx');
await page.waitForFunction(() => !document.querySelector('.sheetwrap'), null, { timeout: 4000 });
T('the sheet closes again', true);
await b.close();
finish();
