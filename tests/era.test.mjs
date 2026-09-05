/* When the way we measure changes, everything before it is history.
   The first ride the accurate model actually ran on (v43, 5 Sep) read the
   knee at 24.7° where the sweep model had read 32–34° on the same rider and
   bike. Pooling those would have told the rider their reads disagree wildly
   when it was our model that changed. So a stored knee carries which way it
   was measured, and only the newest way with any rides in it is pooled. */
import { browser, BASE, T, finish } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage();
await page.goto(`${BASE}/index.html`);

const r = await page.evaluate(async () => {
  const A = await import('/js/analysis.js');
  const flat = { kneeBendBDC: { value: 30, sd: 3, strokes: 12 } };
  const lite3d = { howRead: { method: "peaks", space: "3d" }, refined: { strokes: 0 }, kneeBendBDC: { value: 33, sd: 2, strokes: 16 } };
  const heavyPeaks = { howRead: { method: "peaks", space: "3d" }, refined: { strokes: 20 }, kneeBendBDC: { value: 24.7, sd: 1.7, strokes: 20, corrected: null } };
  const curveUncorrected = { howRead: { method: "curve" }, refined: { strokes: 0, fineModelError: "timed out" }, kneeBendBDC: { value: 32, sd: 2, strokes: 18, corrected: null } };
  const curveCorrected = { howRead: { method: "curve" }, refined: { strokes: 16 }, kneeBendBDC: { value: 26.1, sd: 1.5, strokes: 18, corrected: -6.2, se: 0.4 } };
  const reads = [flat, lite3d, heavyPeaks, curveUncorrected, curveCorrected].map(A.kneeReadOf);
  const pooledAll = A.comparable(reads).map((x) => x.value);
  const pooledNoHeavy = A.comparable([flat, lite3d, curveUncorrected].map(A.kneeReadOf)).map((x) => x.value);
  const pooledOnlyFlat = A.comparable([flat].map(A.kneeReadOf)).map((x) => x.value);
  return { eras: reads.map((x) => x.era), pooledAll, pooledNoHeavy, pooledOnlyFlat, se: reads[4].se };
});

T('each stored knee says how it was measured',
  JSON.stringify(r.eras) === JSON.stringify(["flat", "3d", "heavy", "3d", "heavy"]), r.eras.join(", "));
T('once the accurate model has read a ride, only rides read that way are pooled',
  JSON.stringify(r.pooledAll) === JSON.stringify([24.7, 26.1]), r.pooledAll.join(", "));
T('before that, the metric-pose rides are pooled and the flat ones are history',
  JSON.stringify(r.pooledNoHeavy) === JSON.stringify([33, 32]), r.pooledNoHeavy.join(", "));
T('and with nothing newer, the old set stands', JSON.stringify(r.pooledOnlyFlat) === JSON.stringify([30]));
T('a corrected curve read keeps its measured uncertainty for pooling', r.se === 0.4);
await b.close();
finish();
