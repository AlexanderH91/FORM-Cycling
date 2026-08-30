/* What the home screen is allowed to say.
 *
 * It said: "You ride at the straight-leg end. Your knee bends 30° at the
 * bottom of the stroke, and riders sit between 30° and 40°. You are right at
 * the straighter end of that, ride after ride — so it is where you ride, not a
 * shaky reading."
 *
 * That last clause is the app reassuring itself about its own measurement. A
 * rider does not need to be told our reading is not shaky; they need to know
 * what their leg is doing, where the work is landing, and whether to touch
 * anything. And it was not even true: the report, two taps away, was telling
 * the same rider on the same rides that the readings could not all be right. */
import { browser, BASE, T, finish } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage();
await page.goto(`${BASE}/index.html`);

const r = await page.evaluate(async () => {
  const { standing } = await import('/js/analysis.js');
  const ride = (v) => ({ value: v, sd: 3, n: 14, of: 16, conf: 0.9 });
  const many = (...v) => v.map(ride);
  return {
    // the rider's own nine rides: 27° to 39°, averaging the bottom edge
    scattered: standing(many(27, 39, 30, 36, 28, 38, 31, 34, 30)),
    middle:    standing(many(34, 35, 34, 36, 35, 34)),
    tight30:   standing(many(30, 30, 31, 30, 29, 30)),
    tight40:   standing(many(39, 40, 39, 40, 39, 40)),
    high:      standing(many(23, 24, 22, 24, 23, 24)),
    low:       standing(many(47, 46, 48, 46, 47, 46)),
    // two rides, and they land on the edge — the case that needs a third
    twoRides:  standing(many(30, 31)),
    // two rides in the clear middle: a third would not change the advice
    twoClear:  standing(many(34, 35)),
    nothing:   standing([]),
  };
});

const all = Object.entries(r).filter(([, v]) => v);

/* Nothing about how sure we are. That is our business, not the rider's. */
const SELF_TALK = /shaky|reading|not an unclear|margin|we are confident|reliable|our (measurement|reading)/i;
const talksToItself = all.filter(([, v]) => SELF_TALK.test(v.line));
T('no line reassures the rider about our own measurement',
  talksToItself.length === 0,
  talksToItself.map(([k, v]) => `${k}: "${v.line.slice(0, 60)}…"`).join(' | ') || `${all.length} states, all about the rider`);

/* Every line says what the body is doing AND what to do about it. */
const BODY = /\b(hamstring|knee|hips?|quad|glute|muscles?|push|stroke|leg)\b/i;
const ACTION = /\b(drop|raise|take|add|film|nothing to change|see how)\b/i;
const noBody = all.filter(([, v]) => !BODY.test(v.line));
const noAction = all.filter(([, v]) => !ACTION.test(v.line));
T('every line says what your leg is actually doing', noBody.length === 0,
  noBody.map(([k]) => k).join(', ') || `${all.length} states`);
T('and what to do about it, even if that is nothing', noAction.length === 0,
  noAction.map(([k]) => k).join(', ') || 'each one ends somewhere actionable');

/* The one that started this: scattered rides are not a position. */
T('rides that disagree with each other are not called a position',
  /cannot all be right/.test(r.scattered.line) && r.scattered.word === 'Not settled',
  `"${r.scattered.head}"`);
T('and home says exactly what the report says about them',
  /different answer nearly every time/.test(r.scattered.line),
  'one wording, one source, no arguing with itself two taps away');

T('a rider in the middle is told to leave it alone',
  /Nothing to change/.test(r.middle.line) && r.middle.word === 'Good', `"${r.middle.head}"`);
T('at the straight-leg end the saddle comes down, not up',
  /take 2–3 mm out/.test(r.tight30.line) && /top of its useful range/.test(r.tight30.head),
  `"${r.tight30.head}"`);
T('and at the bent-leg end it goes up',
  /add 2–3 mm/.test(r.tight40.line) && /bottom of its useful range/.test(r.tight40.head),
  `"${r.tight40.head}"`);
T('a leg straightening far is a saddle too high',
  /too high/.test(r.high.head) && /Drop the saddle/.test(r.high.line), `"${r.high.head}"`);
T('a knee still bent is a saddle too low',
  /too low/.test(r.low.head) && /Raise the saddle/.test(r.low.line), `"${r.low.head}"`);
T('two rides on the edge is not yet an answer',
  /One more ride/.test(r.twoRides.head), `"${r.twoRides.head}"`);
T('but two rides in the clear does not ask for a third',
  r.twoClear.word === 'Good', `"${r.twoClear.head}" — "change nothing" needs no more evidence`);
T('and no rides is not an answer at all', r.nothing === null);

/* Home renders it; it does not decide it again. */
const wiring = await page.evaluate(async () => {
  const src = await (await fetch('/js/pages/home.js')).text();
  return {
    usesTheSharedOne: /standing as standing_/.test(src) && /standing_\(reads\)/.test(src),
    decidesNothing: !/verdictWith/.test(src) && !/BANDS/.test(src),
    saysItOnce: (src.match(/standing\?\.line/g) || []).length === 1,
  };
});
T('home renders the shared answer rather than working out its own',
  wiring.usesTheSharedOne && wiring.decidesNothing);
T('and prints it once, not once per card', wiring.saysItOnce,
  'both cards used to print the same sentence');

await b.close();
finish();
