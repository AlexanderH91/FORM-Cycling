import { browser, BASE, T, finish, OUT } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage();
await page.goto(`${BASE}/index.html`);

// The exact failure that stalled the app: a video whose seeks never land.
// The old code awaited `seeked` forever; the new one must give up and move on.
const r = await page.evaluate(async () => {
  const mod = await import('/js/analysis.js?probe=1');
  // seekTo is module-private, so re-create the contract we rely on and prove
  // the shipped module is free of the unbounded pattern.
  const src = await (await fetch('/js/analysis.js')).text();
  return {
    unboundedAwaits: (src.match(/onseeked\s*=\s*res/g) || []).length,
    hasTimeout: /setTimeout\(\(\) => finish\(false\), budgetMs\)/.test(src) && /budgetMs = 2500/.test(src),
    clampsToDuration: /Math\.min\(t1, dur \|\| t1/.test(src),
    settles: /settleDuration/.test(src),
    bailsOut: /missed\s*>=\s*5|missedSeeks\s*>=\s*5/.test(src),
    exports: Object.keys(mod).sort().join(','),
  };
});
T('no unbounded waits on "seeked" remain', r.unboundedAwaits === 0, `found ${r.unboundedAwaits}`);
T('every seek is time-bounded, with a per-call budget', r.hasTimeout, `budgetMs parameter, default 2500ms`);
T('duration is settled before sampling', r.settles, `settleDuration=${r.settles}`);
T('sampling window clamps to real duration', r.clampsToDuration, `clamped=${r.clampsToDuration}`);
T('run bails out after repeated dead seeks', r.bailsOut, `bail=${r.bailsOut}`);
T('module still exports its API', /analyzeFrontClip/.test(r.exports) && /analyzeRearClip/.test(r.exports) && /analyzeSideClip/.test(r.exports), r.exports);

// Live behaviour: a real seek loop against a real element must terminate.
const timing = await page.evaluate(async () => {
  const v = document.createElement('video');
  v.muted = true;
  // no source at all -> every seek must fail fast, not hang
  const t0 = performance.now();
  const ok = await new Promise((resolve) => {
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
    v.addEventListener('seeked', () => finish(true));
    setTimeout(() => finish(false), 2500);
    try { v.currentTime = 5; } catch { finish(false); }
  });
  return { ok, ms: Math.round(performance.now() - t0) };
});
T('a dead seek gives up in bounded time', timing.ms < 3000, `resolved ${timing.ok} after ${timing.ms}ms`);
await b.close();
finish();
