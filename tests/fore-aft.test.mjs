/* Saddle fore/aft — the gap named in every review of a rival app ("doesn't
   consider saddle position fore and aft"). Driven with a synthetic rider whose
   geometry is known, so the sign and the size of the answer can be checked
   rather than eyeballed. */
import { browser, BASE, T, finish } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage();
await page.goto(`${BASE}/index.html`);

const r = await page.evaluate(async () => {
  const A = await import('/js/analysis.js');
  const C = await import('/js/config.js');
  const FPS = 15;

  /* Build a rider pedalling, seen from the side, facing LEFT (so "forward" is
     -x). The ankle traces a circle; the knee sits a known distance ahead of
     it. Everything is already square-corrected, as rows are by this point. */
  const make = ({ kneeAheadOfAxle, facing = -1, seconds = 6 }) => {
    const rows = [];
    const crankR = 0.06, femurLen = 0.20;
    for (let i = 0; i < FPS * seconds; i++) {
      const a = (i / FPS) * 2 * Math.PI * 1.4;          // ~84 rpm
      const ankle = { x: 0.5 + facing * crankR * Math.cos(a), y: 0.6 + crankR * Math.sin(a) };
      // foot: toe ahead of heel by 0.05
      const toe  = { x: ankle.x + facing * 0.05 };
      const heel = { x: ankle.x - facing * 0.02 };
      const axle = toe.x + C.AXLE_ALONG_FOOT * (heel.x - toe.x);
      const knee = { x: axle + facing * kneeAheadOfAxle, y: ankle.y - 0.20 };
      const hip  = { x: knee.x - facing * 0.02, y: knee.y - femurLen };
      const sho  = { x: hip.x + facing * 0.12 };          // shoulders reach forward
      rows.push({
        conf: 0.9,
        x: { hip: hip.x, knee: knee.x, ankle: ankle.x, sho: sho.x, heel: heel.x, toe: toe.x },
        femur: Math.hypot(knee.x - hip.x, knee.y - hip.y),
      });
    }
    return rows;
  };

  const ahead  = A.kneeOverAxle(make({ kneeAheadOfAxle:  0.03 }), FPS);
  const behind = A.kneeOverAxle(make({ kneeAheadOfAxle: -0.03 }), FPS);
  const over   = A.kneeOverAxle(make({ kneeAheadOfAxle:  0.0  }), FPS);
  const otherWay = A.kneeOverAxle(make({ kneeAheadOfAxle: 0.03, facing: 1 }), FPS);
  const tooShort = A.kneeOverAxle(make({ kneeAheadOfAxle: 0.03, seconds: 1 }), FPS);
  const femur = Math.hypot(0.02, 0.20);

  return {
    ahead: ahead && +ahead.ofFemur.toFixed(3), aheadN: ahead?.n,
    behind: behind && +behind.ofFemur.toFixed(3),
    over: over && +over.ofFemur.toFixed(3),
    otherWay: otherWay && +otherWay.ofFemur.toFixed(3),
    tooShort,
    expected: +(0.03 / femur).toFixed(3),
    cmAt180: ahead && +(ahead.ofFemur * C.FEMUR_OVER_HEIGHT * 180).toFixed(1),
    ratio: C.FEMUR_OVER_HEIGHT, axle: C.AXLE_ALONG_FOOT,
  };
});

T('a knee ahead of the axle reads positive, at the right size',
  Math.abs(r.ahead - r.expected) < 0.02, `got ${r.ahead} thigh-lengths, expected ${r.expected}`);
T('a knee behind it reads negative', Math.abs(r.behind + r.expected) < 0.02, `got ${r.behind}`);
T('a knee over it reads about zero', Math.abs(r.over) < 0.02, `got ${r.over}`);
T('a rider facing the other way is not mirrored',
  Math.abs(r.otherWay - r.ahead) < 0.02, `facing left ${r.ahead} vs facing right ${r.otherWay}`);
T('it measures across several strokes, not one', r.aheadN >= 3, `${r.aheadN} strokes`);
T('too few strokes returns nothing rather than a number', r.tooShort === null, `got ${JSON.stringify(r.tooShort)}`);
T('centimetres are derived, and stay plausible',
  r.cmAt180 > 1 && r.cmAt180 < 12, `${r.cmAt180} cm for a 180 cm rider (thigh ratio ${r.ratio}, axle ${r.axle})`);
/* What the card actually puts in its value slot. It read "+25% of thigh",
   which is not a unit anyone thinks in and carries a decimal of precision on a
   figure the same card calls approximate. */
const shown = await page.evaluate(async () => {
  const { kneeOverAxle } = await import('/js/analysis.js');
  /* A stroke set where the knee sits a long way from the axle — far enough
     that it is the model having lost the foot, not a rider position. */
  const wild = Array.from({ length: 40 }, (_, i) => {
    const a = (i / 10) * 2 * Math.PI;
    return { conf: 0.9, femur: 0.20,
      x: { sho: 0.30, hip: 0.50, knee: 0.30, ankle: 0.42 + 0.10 * Math.cos(a),
           heel: 0.52, toe: 0.44 } };
  });
  return { wild: kneeOverAxle(wild, 15) };
});
T('a knee further from the axle than a rider ever sits reports nothing',
  shown.wild === null, 'there was no ceiling on this at all');

{
  const src = await (await fetch(`${BASE}/js/analysis.js`)).text();
  // the phrase survives in the note explaining why it went; the code must not
  T('the value is centimetres, or a position in words — never "% of thigh"',
    !/ofFemur \* 100/.test(src) && /"Over the pedal"/.test(src)
      && /"Ahead of the pedal"/.test(src) && /"Behind the pedal"/.test(src));
  T('and the chips beside every number say what they mean',
    /=== "ok" \? "In range"/.test(src) && /"At the edge"/.test(src) && /"Worth a look"/.test(src),
    '"Close" was ours — close to what, and is close good?');
}

await b.close();
finish();
