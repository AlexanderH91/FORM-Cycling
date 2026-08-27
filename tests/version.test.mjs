/* The build badge exists for one job: tell you, without trusting the app's own
   JavaScript, which code the phone is running. So the tests here check it
   survives the failures it is meant to report on. */
import { browser, BASE, T, finish } from './lib.mjs';
import { readFileSync } from 'node:fs';

const chromium = await browser();
const b = await chromium.launch();

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const cfg  = readFileSync(new URL('../js/config.js', import.meta.url), 'utf8');
const htmlBuild = html.match(/data-build="([^"]+)"/)?.[1];
const jsBuild   = cfg.match(/BUILD = "([^"]+)"/)?.[1];
const htmlVer   = html.match(/data-version="([^"]+)"/)?.[1];
const jsVer     = cfg.match(/VERSION = "([^"]+)"/)?.[1];
T('the two build strings are kept in step', htmlBuild === jsBuild, `html=${htmlBuild} js=${jsBuild}`);
T('so are the two version strings', htmlVer === jsVer, `html=${htmlVer} js=${jsVer}`);

// The pill's own text is static markup, so it can drift from both of them.
const tagText = html.match(/id="vertag"[^>]*>\s*([^<]+)/)?.[1].trim();
T('the pill shows the version it ships', tagText === htmlVer, `pill="${tagText}" version=${htmlVer}`);
// A rename is also a purge, so the worker has to be bumped with the version.
const swCache = readFileSync(new URL('../sw.js', import.meta.url), 'utf8').match(/CACHE = "([^"]+)"/)?.[1];
T('the worker cache is bumped with it', swCache?.endsWith(htmlVer), `cache=${swCache}`);

/* Requests a service worker makes are invisible to page.route, so the suites
   that fake a stale deploy run with workers blocked. The first block keeps them
   on, because the worker is half of what makes a deploy land. */
const phone = { viewport: { width: 393, height: 852 } };
const ctx = (opts) => b.newContext({ ...phone, ...opts });

// --- normal load: badge is in the page and both halves agree -----------------
{
  const page = await (await ctx()).newPage();
  await page.goto(`${BASE}/#/login`);
  await page.waitForSelector('#ver');

  const seen = await page.evaluate(() => {
    const tag = document.getElementById('vertag');
    const r = tag.getBoundingClientRect();
    return { label: tag.textContent.trim(), onScreen: r.top >= 0 && r.right <= innerWidth && r.width > 0 };
  });
  T('a version tag is visible on screen', seen.onScreen && seen.label.includes(htmlVer), `label="${seen.label}"`);

  await page.click('#vertag');
  await page.waitForFunction(() => document.getElementById('verjs').textContent !== 'loading…', null, { timeout: 8000 });
  const panel = await page.evaluate(() => ({
    html: document.getElementById('verhtml').textContent,
    js:   document.getElementById('verjs').textContent,
    dot:  document.getElementById('verdot').className,
    msg:  document.getElementById('vermsg').textContent,
  }));
  T('the panel reports the page build', panel.html === htmlBuild, `page=${panel.html}`);
  T('the panel reports the module build', panel.js === jsBuild, `scripts=${panel.js}`);
  T('matching builds read as healthy', /ok/.test(panel.dot), `dot="${panel.dot}" msg="${panel.msg}"`);

  // The worker is what keeps the two builds in step on the next deploy.
  const sw = await page.evaluate(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    return { count: regs.length, scope: regs[0]?.scope ?? '', label: document.getElementById('versw').textContent };
  });
  T('a network-first worker is registered', sw.count === 1, `scope=${sw.scope} panel="${sw.label}"`);

  /* A reload on every first visit would abort the module loads already in
     flight — the healing reload is only allowed when the builds disagree. */
  await page.evaluate(() => { window.__survived = true; });
  await page.waitForTimeout(1500);
  const kept = await page.evaluate(() => window.__survived === true);
  T('a healthy page is never reloaded out from under you', kept);
  await page.close();
}

// --- the case it exists for: modules are stale ------------------------------
{
  const page = await (await ctx({ serviceWorkers: 'block' })).newPage();
  // Serve a config.js from an older deploy — exactly what a phone's HTTP cache
  // does — and leave everything else current.
  await page.route('**/js/config.js', (route) =>
    route.fulfill({ contentType: 'application/javascript',
      body: cfg.replace(`BUILD = "${jsBuild}"`, 'BUILD = "1999-01-01-a"') }));
  await page.goto(`${BASE}/#/login`);
  await page.click('#vertag');
  await page.waitForFunction(() => document.getElementById('verjs').textContent !== 'loading…', null, { timeout: 8000 });
  const stale = await page.evaluate(() => ({
    js: document.getElementById('verjs').textContent,
    dot: document.getElementById('verdot').className,
    msg: document.getElementById('vermsg').textContent,
  }));
  T('stale modules are named, not guessed at', stale.js === '1999-01-01-a', `scripts=${stale.js}`);
  T('and called out as cached', /bad/.test(stale.dot) && /cache/i.test(stale.msg), `msg="${stale.msg}"`);
  await page.close();
}

// --- the worse case: modules never run at all -------------------------------
{
  const page = await (await ctx({ serviceWorkers: 'block' })).newPage();
  await page.route('**/js/main.js*', (route) => route.abort());
  await page.goto(`${BASE}/#/login`).catch(() => {});
  const alive = await page.evaluate(() => !!document.getElementById('vertag'));
  T('the badge still renders when the app never starts', alive);
  await page.click('#vertag');
  await page.waitForFunction(() => document.getElementById('verjs').textContent !== 'loading…', null, { timeout: 12000 });
  const dead = await page.evaluate(() => ({
    js: document.getElementById('verjs').textContent,
    msg: document.getElementById('vermsg').textContent,
    flush: !!document.getElementById('verflush'),
  }));
  T('silence is reported as silence', dead.js === 'no answer', `scripts=${dead.js}`);
  T('and a way out is offered', dead.flush && /Force refresh/.test(dead.msg), `msg="${dead.msg}"`);
  await page.close();
}

// --- force refresh clears state and reloads on a fresh URL ------------------
{
  const page = await (await ctx({ serviceWorkers: 'block' })).newPage();
  await page.goto(`${BASE}/#/login`);
  await page.evaluate(async () => { const c = await caches.open('stale-junk'); await c.put('/x', new Response('old')); });
  await page.click('#vertag');
  await page.click('#verflush');
  await page.waitForFunction(() => /fresh=/.test(location.search), null, { timeout: 8000 });
  const after = await page.evaluate(async () => ({
    url: location.search, keys: await caches.keys(),
  }));
  T('force refresh lands on a URL no cache can answer', /fresh=\d+/.test(after.url), `search=${after.url}`);
  T('and the old caches are gone', !after.keys.includes('stale-junk'), `caches=${JSON.stringify(after.keys)}`);
  await page.close();
}

await b.close();
finish();
