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
  const S = await import('/js/analysis.js');
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
    legsByPosition: (() => {
      /* Facing the camera, the model swaps its own left/right labels readily,
         and a swap moves one leg's lean into the other leg's series. Run the
         same clip twice with the labels exchanged: the rider's left leg must
         come back as the rider's left leg either way. */
      const AR = 1080 / 1920;
      // The two legs lean differently, so a swap would show up if it happened.
      const legAt = (x, k, a) => ({ hip: { x, y: 0.40 }, knee: { x: x + k, y: 0.50 },
                                    ankle: { x: x + a, y: 0.62 }, ends: true, clean: true });
      const build = (swap) => {
        const rows = [];
        for (let i = 0; i < 12; i++) {
          const near = legAt(AR / 2 + 0.06, 0.02, 0.05), far = legAt(AR / 2 - 0.06, -0.03, -0.06);
          rows.push({ t: i / 12, ar: AR, vis: 0.9,
                      legs: swap ? { l: far, r: near } : { l: near, r: far } });
        }
        S.settleFrontLegs(rows, 12);
        return rows.map((x) => [x.left, x.right]);
      };
      const plain = build(false), swapped = build(true);
      return JSON.stringify(plain) === JSON.stringify(swapped);
    })(),
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

/* Visibility is not anatomy. From the front, with the bars across the legs,
   the model placed "knee" and "ankle" on a forearm and the app drew a line
   there and called it knee travel. */
const anatomy = await page.evaluate(async () => {
  const src = await (await fetch('/js/analysis.js')).text();
  const pageSrc = await (await fetch('/js/pages/analyze.js')).text();

  /* The shipped rule itself, not a copy of it: frontLegs is what both the
     measurement and the still now ask, so drive that. */
  const S = await import('/js/analysis.js');
  const marks = (hipY, kneeY, ankleY) => {
    const p = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.99 }));
    p[23] = { x: 0.5, y: hipY, visibility: 0.99 };
    p[25] = { x: 0.5, y: kneeY, visibility: 0.99 };
    p[27] = { x: 0.5, y: ankleY, visibility: 0.99 };
    return p;
  };
  const sq = S.squareUp(1080 / 1920);
  const isLeg = (hipY, kneeY, ankleY) => S.frontLegs(marks(hipY, kneeY, ankleY), sq).l.clean;
  return {
    realLeg: isLeg(0.55, 0.72, 0.90),
    forearm: isLeg(0.55, 0.48, 0.60),       // "knee" above the hip: an arm
    invertedShin: isLeg(0.55, 0.72, 0.65),  // "ankle" above the "knee"
    /* One rule, asked in both places — the measurement's sampler and the
       still's draw callback. They cannot drift apart into disagreeing about
       the same frame, which is how a shin came to be drawn along a forearm
       while the numbers were correctly ignoring it. */
    checksMeasurement: /const legs = frontLegs\(p, sq\);/.test(src),
    checksStill: /const legs = frontLegs\(p, squareUp\(ar\)\);/.test(src),
    checksRear: /const upright = Math\.min\(p\[11\]\.y, p\[12\]\.y\) < Math\.min\(p\[23\]\.y, p\[24\]\.y\)/.test(src),
    /* The instruction, not the comment explaining why it changed: "bar height"
       still appears in the note above it, and should. */
    framingFixed: /down at hub height/.test(pageSrc) && !/hint: "[^"]*bar height/.test(pageSrc),
  };
});
T('a real leg passes: knee below hip, ankle below knee', anatomy.realLeg);
T('a forearm does not — its "knee" sits above the hip', anatomy.forearm === false);
T('nor does an upside-down shin', anatomy.invertedShin === false);
T('the check guards the measurement and the still alike',
  anatomy.checksMeasurement && anatomy.checksStill,
  'the picture can never draw a leg the numbers rejected');
T('the rear view checks shoulders sit above hips', anatomy.checksRear);
T('and the front view no longer asks for the camera at bar height', anatomy.framingFixed,
  'bar height puts the bars across the very joints this view needs');

/* The picture and the numbers must agree about the same frame. The front
   track carried all four leg landmarks whatever the anatomy check decided, so
   the player drew a shin along a forearm while the measurement was correctly
   ignoring it. And from behind, a rider bent over the bars hides their own
   hips: the model stacks both markers on the spine, and two points that close
   together cannot define a line at all. */
const tracks = await page.evaluate(async () => {
  const C = await import('/js/config.js');
  const S = await import('/js/analysis.js');
  const src = await (await fetch('/js/analysis.js')).text();
  const css = await (await fetch('/css/app.css')).text();
  const pageSrc = await (await fetch('/js/pages/analyze.js')).text();

  // where the tabs sit in the player markup
  const stage = pageSrc.indexOf('<div class="stagewrap">');
  const tabs = pageSrc.indexOf('id="mvtabs"');
  return {
    frontTrackFiltered: (() => {
      /* A leg the measurement would not use must leave nothing behind for the
         player to draw. One leg unusable: only the other leg's joints travel.
         Neither usable: the frame carries no drawing at all. */
      const AR = 1080 / 1920;
      const ok = { hip: { x: 0.34, y: 0.40 }, knee: { x: 0.35, y: 0.50 },
                   ankle: { x: 0.37, y: 0.62 }, ends: true, clean: true };
      const gone = { hip: { x: 0, y: 0 }, knee: { x: 0, y: 0 },
                     ankle: { x: 0, y: 0 }, ends: false, clean: false };
      const rows = [];
      for (let i = 0; i < 10; i++) rows.push({ t: i / 12, ar: AR, vis: 0.9, legs: { l: ok, r: gone } });
      rows.push({ t: 10 / 12, ar: AR, vis: 0.9, legs: { l: gone, r: gone } });
      S.settleFrontLegs(rows, 12);
      const keys = Object.keys(rows[5].j || {});
      return keys.length === 3 && keys.every((k) => k[0] === 'l') && rows[10].j === null;
    })(),
    rearTrackFiltered: /if \(row\.shoulder != null\) \{ row\.j\.lsho/.test(src),
    spanChecked: /shoulderW >= SANITY\.minSpanOfFrame/.test(src)
      && /hipW >= shoulderW \* SANITY\.hipOverShoulder/.test(src),
    span: C.SANITY.minSpanOfFrame, hipRatio: C.SANITY.hipOverShoulder,
    tabsBelowVideo: tabs > stage,
    segmented: /\.angletabs\{[^}]*padding:3px/.test(css),
  };
});
T('the front track carries only legs that passed the anatomy check',
  tracks.frontTrackFiltered, 'the player can no longer draw what the numbers rejected');
T('the rear track carries only lines that were measurable', tracks.rearTrackFiltered);
T('a torso too narrow to measure is refused', tracks.spanChecked,
  `shoulders must span ${tracks.span} of frame, hips ${tracks.hipRatio} of shoulders`);
T('the angle switcher sits under the footage, not above it', tracks.tabsBelowVideo);
T('and reads as one segmented control', tracks.segmented);

await b.close();
finish();
