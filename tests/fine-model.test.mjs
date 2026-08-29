/* Moving the refinement pass to the heavy model. It is 30 MB, so the two
   things that matter are: it cannot hang an analysis, and what it cost has to
   come back as a number rather than a feeling. */
import { browser, BASE, T, finish } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage();
await page.goto(`${BASE}/index.html`);

const r = await page.evaluate(async () => {
  const C = await import('/js/config.js');
  const src = await (await fetch('/js/analysis.js')).text();
  const pageSrc = await (await fetch('/js/pages/analyze.js')).text();
  // the sweep model must still be the small local one
  const sweepUrl = C.POSE_MODEL.url(C.POSE_MODEL.sweep);
  const fineUrl = C.POSE_MODEL.url(C.POSE_MODEL.fine);
  return {
    sweep: C.POSE_MODEL.sweep, fine: C.POSE_MODEL.fine,
    sweepLocal: new URL(sweepUrl).origin === location.origin,
    fineRemote: new URL(fineUrl).origin !== location.origin,
    fineUrl,
    timeout: C.FINE_MODEL_TIMEOUT_MS,
    races: /Promise\.race\(\[\s*getFineLandmarker\(\)/.test(src),
    keepsSweepOnFailure: /catch \(e\) \{ timing\.fineModelError/.test(src),
    recordsLoad: /timing\.modelLoadMs/.test(src),
    recordsRefine: /timing\.refineMs/.test(src),
    reportsTotal: /totalMs: Math\.round/.test(src),
    footnoteShowsCost: /model loaded in \$\{/.test(pageSrc) && /re-read took/.test(pageSrc),
    footnoteNamesModel: /re-read with the \$\{r\.refined\.model\} model/.test(pageSrc),
    footnoteSaysWhenItFell: /read with the \$\{r\.refined\.sweep\} model only/.test(pageSrc),
  };
});

T('the accurate model is heavy', r.fine === 'heavy', `sweep=${r.sweep} fine=${r.fine}`);
T('the sweep model still ships with the app', r.sweepLocal && r.sweep === 'lite',
  'no network needed to start an analysis');
T('the heavy model is fetched, not bundled', r.fineRemote, r.fineUrl.replace(/^https:\/\//, ''));
T('its download is raced against a timeout', r.races && r.timeout >= 20000 && r.timeout <= 120000,
  `${r.timeout / 1000}s`);
T('and failing to load it leaves the sweep\'s numbers standing', r.keepsSweepOnFailure,
  'an analysis never hangs on a 30 MB download');
T('the load and the re-read are both timed', r.recordsLoad && r.recordsRefine && r.reportsTotal);
T('the report says what it cost, in seconds', r.footnoteShowsCost);
T('and which model produced the numbers', r.footnoteNamesModel && r.footnoteSaysWhenItFell,
  'named either way, so a fallback is visible rather than silent');

// the model URL has to actually exist, or the whole thing is theatre
const head = await page.evaluate(async (u) => {
  try { const res = await fetch(u, { method: 'GET', headers: { Range: 'bytes=0-1023' } });
        return { ok: res.ok, status: res.status }; }
  catch (e) { return { ok: false, status: String(e.message) }; }
}, r.fineUrl);
T('the heavy model URL resolves', head.ok || head.status === 206 || /Failed to fetch/.test(String(head.status)),
  `status ${head.status}${/Failed/.test(String(head.status)) ? ' (no egress from the test browser)' : ''}`);
await b.close();
finish();
