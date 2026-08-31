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

/* Scattered rides are still not a position — but the headline opens on the
   rider, not on our difficulty. "We can't call your saddle height yet" is an
   apology, and it was the first thing anyone read when they opened the app. */
T('rides that disagree with each other are not called a position',
  r.scattered.word === 'Not settled' && /something in the filming did/.test(r.scattered.line),
  `"${r.scattered.head}"`);
T('and the headline is about the rider, not about our difficulty',
  /Your knee bends/.test(r.scattered.head) && !/^We /.test(r.scattered.head),
  `"${r.scattered.head}" — three lines of apology used to come first`);

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
  r.twoRides.word === 'Not settled' && /not quite enough/.test(r.twoRides.line),
  `"${r.twoRides.head}"`);
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

/* Readings taken before we changed how we measure are history, not evidence.
   A rider opened the app to "17 rides, 27° at the lowest, 39° at the highest";
   thirteen of those seventeen predate measuring the angle in three dimensions,
   and the four since sat within 1.4° of each other. That spread was a record
   of our own changes, shown to a rider as instability in their riding. */
const eras = await page.evaluate(async () => {
  const { standing, comparable } = await import('/js/analysis.js');
  const old = (v) => ({ value: v, sd: 3, n: 14, era: 'flat' });
  const now = (v) => ({ value: v, sd: 3, n: 14, era: '3d' });
  const mixed = [old(27), old(39), old(28), old(38), old(30),
                 now(33.4), now(32.8), now(34.1), now(34.2)];
  return {
    keptOnlyCurrent: comparable(mixed).length === 4,
    allOldStillCounts: comparable([old(31), old(33)]).length === 2,
    verdict: standing(mixed),
    wouldHaveBeen: standing(mixed.map((r) => ({ ...r, era: 'flat' }))),
  };
});
T('rides measured the old way are left out of the average',
  eras.keptOnlyCurrent, 'four comparable rides out of nine');
T('unless there are no current ones, in which case they still stand',
  eras.allOldStillCounts, 'a rider who has not filmed since is not left with nothing');
T('so a rider who has earned an answer gets one',
  eras.verdict.word === 'Good' && /doing its job/.test(eras.verdict.head),
  `"${eras.verdict.head}" — the same rides pooled together read "${eras.wouldHaveBeen.word}"`);

/* A settled saddle is not the end of the app. "Your saddle height is doing its
   job, nothing to change" was the whole of the home screen for a rider who had
   got there — true, useful once, and no reason to ever open it again. */
const next = await page.evaluate(async () => {
  const { standing, nextStep } = await import('/js/analysis.js');
  const ride = (v) => ({ value: v, sd: 3, n: 14, era: '3d' });
  const settled = standing([34, 35, 34, 36, 35, 34].map(ride));
  const unsettled = standing([30, 31].map(ride));
  return {
    noFront:  nextStep(settled, { front: false, rear: false }),
    noRear:   nextStep(settled, { front: true, rear: false }),
    allRead:  nextStep(settled, { front: true, rear: true }),
    unsettled: nextStep(unsettled, { front: true, rear: true }),
    nothing:  nextStep(null, {}),
  };
});

T('a rider whose saddle is settled is sent to the angle we have never read',
  /knees track straight/.test(next.noFront.head) && next.noFront.to === '#/analyze',
  `"${next.noFront.head}"`);
T('then to the other one', /sit level/.test(next.noRear.head), `"${next.noRear.head}"`);
T('and once all three read clean, to whether it made a difference',
  /made you faster/.test(next.allRead.head) && next.allRead.to === '#/connect',
  `"${next.allRead.head}" — the question stops being what to change`);
T('every step hands over one thing to do',
  [next.noFront, next.noRear, next.allRead].every((s) => s.act && s.to && s.line.length > 120),
  'a headline with no button is a fact, not a next step');
T('a saddle still being settled is not asked for two things at once',
  next.unsettled === null, 'the card above is already asking for a ride');
T('and a rider with no rides is left to the empty state', next.nothing === null);

// home has to render it, and mark it as the thing to act on
const wired = await page.evaluate(async () => {
  const src = await (await fetch('/js/pages/home.js')).text();
  const css = await (await fetch('/css/app.css')).text();
  return {
    renders: /nextStep\(standing, \{ front: everRead\("front"\), rear: everRead\("rear"\) \}\)/.test(src)
      && /class="glass card next"/.test(src),
    /* Read, not filmed. He has filmed the front and the rear several times and
       both came back refused; nothing on this screen ever said so. */
    countsReadsNotTakes: /!s\.report\[key\]\.gate/.test(src),
    marked: /\.card\.next\{/.test(css),
  };
});
T('home shows the next step and marks it as the one to act on',
  wired.renders && wired.marked);
T('and counts angles we have actually read, not ones that were filmed',
  wired.countsReadsNotTakes, 'both extra views have been filmed and both were refused');

await b.close();
finish();
