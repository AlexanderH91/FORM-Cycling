/* The app was printing impossible numbers on cards with a straight face.
 * From a real session: knee travel 71.3 degrees, pelvic rock 127.6, shoulder
 * rock 171.4. A shoulder line does not tilt 171 degrees — that is the model
 * swapping which side is which, and max-minus-min turning one such frame into
 * the entire answer. */
import { browser, BASE, T, finish } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage();
await page.goto(`${BASE}/index.html`);

const r = await page.evaluate(async () => {
  const C = await import('/js/config.js');
  const src = await (await fetch('/js/analysis.js')).text();

  // amplitude, as shipped
  const pct = (a, q) => { const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]; };
  const amplitude = (a) => (a.length < 8 ? Math.max(...a) - Math.min(...a) : pct(a, 0.9) - pct(a, 0.1));

  // a steady rider: about 6 degrees of travel, plus two frames where the model
  // swapped the labels and the sign inverted
  const clean = Array.from({ length: 40 }, (_, i) => 3 * Math.sin(i / 3));
  const withFlips = [...clean]; withFlips[7] = 171; withFlips[23] = -168;

  // the flip-invariant tilt, as shipped
  const deg = (r) => (r * 180) / Math.PI;
  const tilt = (a, b) => { const [l, rr] = a.x <= b.x ? [a, b] : [b, a];
    return deg(Math.atan2(rr.y - l.y, Math.abs(rr.x - l.x) + 1e-9)); };
  const hipL = { x: 0.42, y: 0.60 }, hipR = { x: 0.58, y: 0.63 };

  return {
    cleanRange: +amplitude(clean).toFixed(1),
    flippedRange: +amplitude(withFlips).toFixed(1),
    oldFlippedRange: +(Math.max(...withFlips) - Math.min(...withFlips)).toFixed(1),
    tiltSame: +tilt(hipL, hipR).toFixed(3),
    tiltSwapped: +tilt(hipR, hipL).toFixed(3),
    ceilings: C.SANITY,
    gatesFront: /more side-to-side travel than a knee has/.test(src),
    gatesRear: /more tilt than a body makes/.test(src),
    usesSane: (src.match(/sane\(\+amplitude/g) || []).length === 4,
    retriesModel: /cache\.delete\(key\); throw e;/.test(src),
    legsByPosition: /legs\.length === 2 && sq\(p\[legs\[0\]\[0\]\]\)\.x > sq\(p\[legs\[1\]\[0\]\]\)\.x/.test(src),
  };
});

T('two swapped frames no longer define the answer',
  Math.abs(r.flippedRange - r.cleanRange) < 0.5 && r.oldFlippedRange > 300,
  `robust ${r.flippedRange}° vs the old max-minus-min ${r.oldFlippedRange}°`);
T('tilt reads the same whichever hip the model calls left',
  Math.abs(r.tiltSame - r.tiltSwapped) < 1e-9, `${r.tiltSame}° either way`);
T('legs are identified by where they are, not what they are called', r.legsByPosition);
T('there are ceilings past which a reading is refused',
  r.ceilings.kneeTravelDeg <= 35 && r.ceilings.rockDeg <= 30,
  `knee travel ${r.ceilings.kneeTravelDeg}°, rock ${r.ceilings.rockDeg}°`);
T('an impossible reading gates instead of rendering', r.usesSane && r.gatesFront && r.gatesRear,
  'front and rear both refuse rather than print');
T('a failed model download is retried next time, not cached forever', r.retriesModel,
  'one bad download used to disable the accurate model for the whole session');

// the real numbers from the rider's own sessions must now be refused
const wouldGate = await page.evaluate(async (vals) => {
  const C = await import('/js/config.js');
  const sane = (v, max) => (Number.isFinite(v) && Math.abs(v) <= max ? v : null);
  return {
    knee: vals.knees.map((v) => sane(v, C.SANITY.kneeTravelDeg)),
    rock: vals.rocks.map((v) => sane(v, C.SANITY.rockDeg)),
  };
}, { knees: [71.3, 73.8, 50, 6.2], rocks: [127.6, 171.4, 145.6, 4.1] });
T('the figures actually shipped to the rider would now be refused',
  wouldGate.knee.slice(0, 3).every((v) => v === null) && wouldGate.rock.slice(0, 3).every((v) => v === null),
  '71.3° / 127.6° / 171.4° all gated');
T('while a plausible reading still gets through',
  wouldGate.knee[3] === 6.2 && wouldGate.rock[3] === 4.1, '6.2° travel, 4.1° rock');
/* The ceiling has to bite one frame at a time, not only on the average. A card
   reading 22 degrees above a picture captioned 52 was two numbers from the same
   measurement disagreeing in public. */
const perFrame = await page.evaluate(async () => {
  const C = await import('/js/config.js');
  const src = await (await fetch('/js/analysis.js')).text();
  // an angle between two points the model put on top of each other
  const deg = (r) => (r * 180) / Math.PI;
  const nearlyCoincident = deg(Math.atan2(0.02, 0.0008));   // dx ~ 0
  return {
    frameCeilings: { knee: C.SANITY.kneeLeanDeg, tilt: C.SANITY.tiltDeg },
    coincidentAngle: +nearlyCoincident.toFixed(1),
    dropsFrontFrame: /if \(Math\.abs\(lean\) > SANITY\.kneeLeanDeg\) continue;/.test(src),
    dropsRearFrame: /Math\.abs\(v\) <= SANITY\.tiltDeg \? v : null/.test(src),
    captionSaysWhich: /The card above is how far it swings across a whole stroke/.test(src),
  };
});
T('two markers with no separation between them make a near-90 degree angle',
  perFrame.coincidentAngle > 85, `${perFrame.coincidentAngle}° from a 0.0008 gap — this is where 82° came from`);
T('such a frame is dropped before it reaches an average',
  perFrame.dropsFrontFrame && perFrame.dropsRearFrame,
  `per frame: knee ${perFrame.frameCeilings.knee}°, tilt ${perFrame.frameCeilings.tilt}°`);
T('and the still says how its number relates to the card\'s', perFrame.captionSaysWhich,
  'one instant versus the swing across a stroke');

await b.close();
finish();
