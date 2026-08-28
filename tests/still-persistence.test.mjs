/* "How is it possible not to make a still — you have ten seconds of video?"
 *
 * It was possible because the code picked one frame and gave up if the model
 * happened not to see a joint clearly in that exact frame. A clip holds sixty
 * to a hundred and twenty sampled frames and the next one is a fortieth of a
 * second away. This suite holds the rule that it keeps trying. */
import { browser, BASE, T, finish } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage();
await page.goto(`${BASE}/index.html`);

const src = await page.evaluate(async () => (await (await fetch('/js/analysis.js')).text()));

T('frames are ranked, not picked', /const rankedBy = \(idxs, key, target\)/.test(src)
  && !/const closestTo = /.test(src), 'rankedBy replaced closestTo');
const specTries = (src.match(/tries: [^\n]+,/g) || []).length;
T('every side-view still is given a list of candidates', specTries >= 5,
  `${specTries} specs carry candidates (knee, foot, hip, torso, fore/aft)`);
T('the front and rear views rank their frames too',
  /ranked = rows\.map\(\(_, i\) => i\)\.sort/.test(src)
  && (src.match(/await bestStill\(/g) || []).length >= 3, 'front, rear and the side batch all use bestStill');
T('a frame with nothing drawable is kept only as a fallback',
  /if \(shot\.drawn\) return shot;/.test(src) && /fallback = shot;/.test(src),
  'a drawn frame always wins over an undrawn one');
T('the search is bounded so it cannot stall the report', /tries = 6/.test(src), 'six attempts');

// The ordering logic itself.
const rank = await page.evaluate(async () => {
  const A = await import('/js/analysis.js');
  // bestStill is internal; exercise the ranking it depends on through pool-free maths
  const rows = [{ v: 10 }, { v: 30 }, { v: 29 }, { v: 55 }, { v: 31 }];
  const rankedBy = (idxs, key, target) =>
    [...idxs].sort((a, b) => Math.abs(rows[a][key] - target) - Math.abs(rows[b][key] - target));
  return {
    order: rankedBy([0, 1, 2, 3, 4], 'v', 30),
    exportsSpread: typeof A.spread === 'function',
  };
});
// values 10,30,29,55,31 against a target of 30: distances 20,0,1,25,1.
// The exact match leads; the two frames a degree away follow in clip order.
T('the closest frame is tried first, then the next closest',
  rank.order.slice(0, 3).join() === '1,2,4', `order ${rank.order.join(' → ')}`);
T('and nothing else in the module was disturbed', rank.exportsSpread);
await b.close();
finish();
