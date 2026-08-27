import { browser, BASE, T, finish, OUT } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 393, height: 852 } });
await page.addInitScript(() => {
  window.__renders = 0;
  new MutationObserver(ms => { for (const m of ms) if (m.target.id === 'view' && m.addedNodes.length) window.__renders++; })
    .observe(document.documentElement, { childList: true, subtree: true });
});
await page.goto(`${BASE}/#/login`);
await page.waitForSelector('#send');
await page.waitForTimeout(800);


const before = await page.evaluate(() => window.__renders);
await page.evaluate(async () => {
  const { supa } = await import('/js/supa.js');
  const cbs = supa.auth.stateChangeEmitters;
  for (const [, e] of cbs) e.callback('TOKEN_REFRESHED', null);
});
await page.waitForTimeout(700);
const after = await page.evaluate(() => window.__renders);
T('TOKEN_REFRESHED no longer re-renders', after === before, `renders ${before} -> ${after}`);

// nav height measured into --nav-h, and the view reserves more than the nav occupies
const geo = await page.evaluate(async () => {
  const nav = document.getElementById('nav');
  nav.classList.remove('hidden');
  await new Promise(r => setTimeout(r, 300));   // let the ResizeObserver land
  const h = nav.offsetHeight;
  const varv = getComputedStyle(document.documentElement).getPropertyValue('--nav-h').trim();
  const pad = parseFloat(getComputedStyle(document.getElementById('view')).paddingBottom);
  return { navH: h, varv, pad };
});
T('--nav-h is measured from the real nav', geo.varv === geo.navH + 'px', `--nav-h=${geo.varv} navH=${geo.navH}px`);
T('view reserves more than the nav occupies', geo.pad > geo.navH + 10, `pad=${geo.pad}px vs nav ${geo.navH}px + 10px offset`);

// a taller nav (bigger text) must widen the reservation too
const grew = await page.evaluate(async () => {
  document.getElementById('nav').style.fontSize = '20px';
  await new Promise(r => setTimeout(r, 300));
  const nav = document.getElementById('nav');
  return { navH: nav.offsetHeight, pad: parseFloat(getComputedStyle(document.getElementById('view')).paddingBottom) };
});
T('reservation tracks a taller nav', grew.pad > grew.navH + 10, `navH=${grew.navH}px pad=${grew.pad}px`);
await b.close();
finish();
