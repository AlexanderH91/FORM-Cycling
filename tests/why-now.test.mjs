/* Every measurement card carries something tangible — a perfect setup
   included. "33°, in range" tells a rider a fact and leaves them to trust it;
   the rule is that we say WHY we think it is right for them right now, written
   for the number actually measured: where in the range it sits, what that end
   means for the muscles doing the work, and what would change if it moved. */
import { browser, BASE, T, finish } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage();
await page.goto(`${BASE}/index.html`);

const r = await page.evaluate(async () => {
  const A = await import('/js/analysis.js');
  const C = await import('/js/config.js');
  const out = [];
  const add = (card, v, band) => out.push({ card, v, text: A.whyNow(card, v, band) });
  // every card, at every end of its range and outside it
  for (const v of [24, 31, 35, 39, 46]) add('knee', v, C.BANDS.kneeBendBDC);
  for (const v of [2, 8, 16, 26]) add('toe', v, C.BANDS.footToeDown6);
  for (const v of [40, 47, 55, 62]) add('hip', v, C.BANDS.hipTDC);
  for (const v of [62, 86, 104]) add('cadence', v, C.BANDS.cadence);
  for (const v of [15, 25, 38, 50]) add('torso', v);
  out.push({ card: 'foreaft', v: 0.02, text: A.whyForeAft(0.02, 0.4) });
  out.push({ card: 'foreaft', v: 0.2, text: A.whyForeAft(0.2, 3.1) });
  out.push({ card: 'foreaft', v: -0.2, text: A.whyForeAft(-0.2, -2.8) });
  out.push({ card: 'front', v: 5, text: A.whyFront(4, 6) });
  out.push({ card: 'front', v: 12, text: A.whyFront(11, 13) });
  out.push({ card: 'front', v: 21, text: A.whyFront(20.5, 21) });
  out.push({ card: 'front', v: 7, text: A.whyFront(null, 7) });
  out.push({ card: 'rock', v: 1, text: A.whyRock(1, 2) });
  out.push({ card: 'rock', v: 4, text: A.whyRock(4, 3) });
  out.push({ card: 'rock', v: 8, text: A.whyRock(8, 5) });
  return out;
});

const BODY = /\b(quads?|glutes?|hamstrings?|calf|muscles?|knee|hip|hips|pelvis|leg|thigh|torso|arms|breath(e|ing)|lungs?|back|feet|foot|ankle)\b/i;
const SHOP = /\bbands?\b|\bverdict|\bcited\b|\bmedian\b|\bprovisional\b|\bmodel\b/i;

const empty = r.filter((x) => !x.text || x.text.length < 90);
T('every card has a why written for every value it can take', empty.length === 0,
  empty.map((x) => `${x.card}@${x.v}`).join(', ') || `${r.length} card-states, shortest ${Math.min(...r.map((x) => x.text.length))} chars`);

const noNumber = r.filter((x) => !/\d/.test(x.text));
T('and it is written for the number that was measured, not in general',
  noNumber.length === 0, noNumber.map((x) => `${x.card}@${x.v}`).join(', ') || 'every one quotes the rider\'s own figure');

const noBody = r.filter((x) => !BODY.test(x.text));
T('and says what the body is doing at that value', noBody.length === 0,
  noBody.map((x) => `${x.card}@${x.v}`).join(', ') || 'a muscle or a joint in all of them');

const notYou = r.filter((x) => !/\byou\b|\byour\b/i.test(x.text));
T('to the rider', notYou.length === 0, notYou.map((x) => `${x.card}@${x.v}`).join(', ') || 'second person throughout');

const shop = r.filter((x) => SHOP.test(x.text));
T('in the rider\'s words', shop.length === 0, shop.map((x) => `${x.card}@${x.v}: ${x.text.match(SHOP)[0]}`).join(', ') || 'no shop talk');

/* The in-range states are the point of this: a good number is explained. */
const good = r.filter((x) => (x.card === 'knee' && x.v === 35) || (x.card === 'toe' && x.v === 8)
  || (x.card === 'hip' && x.v === 55) || (x.card === 'cadence' && x.v === 86) || (x.card === 'rock' && x.v === 1));
T('a perfect setup is explained, not just approved',
  good.every((x) => x.text.length > 150),
  good.map((x) => `${x.card}: "${x.text.slice(0, 48)}…"`).join(' | '));

/* And the two ends of a range say different things — being at 31° is not the
   same as being at 39°, even though both are "in range". */
const kneeLow = r.find((x) => x.card === 'knee' && x.v === 31).text;
const kneeHigh = r.find((x) => x.card === 'knee' && x.v === 39).text;
T('the two ends of a range are told apart',
  kneeLow !== kneeHigh && /straighter end/.test(kneeLow) && /more bend/.test(kneeHigh),
  '31° favours the glutes; 39° loads the quads — same range, different riding');

// wired into the report, not just exported
const wired = await page.evaluate(async () => {
  const src = await (await fetch('/js/analysis.js')).text();
  const pg = await (await fetch('/js/pages/analyze.js')).text();
  return {
    side: ['whyNow("knee"', 'whyNow("toe"', 'whyNow("hip"', 'whyNow("cadence"', 'whyNow("torso"', 'whyForeAft('].every((k) => src.includes(k)),
    frontRear: pg.includes('whyFront(t.left, t.right)') && pg.includes('whyRock(b.pelvicRock'),
  };
});
T('and every measurement card opens its working with it', wired.side && wired.frontRear);

await b.close();
finish();
