/* Verdict rules, driven through the SHIPPED functions rather than a copy of
   them. An earlier version of this suite re-implemented the rule inline and so
   kept passing after the rule changed underneath it. */
import { browser, BASE, T, finish } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage();
await page.goto(`${BASE}/index.html`);

const r = await page.evaluate(async () => {
  const A = await import('/js/analysis.js');
  const C = await import('/js/config.js');
  const KNEE = C.BANDS.kneeBendBDC;
  const v = (value, sd, n) => A.verdictFor({ value, sd, n }, KNEE);
  const ride = (value, sd = 4.4, n = 16) => ({ value, sd, n });
  const poolV = (reads) => {
    const p = A.pool(reads);
    return { ...p, verdict: A.verdictWith(p.value, p.u, KNEE) };
  };
  const src = await (await fetch('/js/analysis.js')).text();
  return {
    band: KNEE, floor: C.ANGLE_FLOOR_DEG, sigmas: C.VERDICT_SIGMAS, settle: C.SETTLE_RIDES,
    // uncertainty about the CENTRE, not the spread of strokes
    u16: +A.uncertainty(ride(29)).toFixed(2),
    u1:  +A.uncertainty({ value: 29, sd: 4.4, n: 1 }).toFixed(2),
    oneRide29: v(29, 4.4, 16),
    clearlyLow:  v(22, 2.0, 16),
    clearlyHigh: v(47, 2.0, 16),
    midBand:     v(35, 4.4, 16),
    noisyMid:    v(35, 20.0, 4),
    // five rides that all land just under the band
    five: poolV([29, 28, 30, 29, 30].map((x) => ride(x))),
    two:  poolV([29, 28].map((x) => ride(x))),
    one:  poolV([ride(29)]),
    // five rides that all land well under it
    fiveLow: poolV([24, 23, 25, 24, 23].map((x) => ride(x))),
    usesMedian: /value: median\(vals\)/.test(src),
    filtersByConfidence: /rows\[i\]\.conf >= CAPTURE\.minJointVisibility/.test(src),
    // ...and only the earlier rides measured the same way as this one
    poolsHistory: /pool\(comparable\(\[\{ value: kneeBDC\.value/.test(src),
  };
});

T('averaging 16 strokes beats one stroke, but not without limit',
  r.u16 < r.u1 && r.u16 >= r.floor && r.u16 < 2.6,
  `one stroke ±${r.u1}° -> 16 strokes ±${r.u16}° (floor ${r.floor}°)`);
T('mid-band is called OK even with a variable rider', r.midBand === 'ok', `35° ±4.4° over 16 -> "${r.midBand}"`);
T('a genuinely unreliable read is still not called', r.noisyMid === 'borderline', `35° ±20° over 4 -> "${r.noisyMid}"`);
T('clear cases read clearly', r.clearlyLow === 'low' && r.clearlyHigh === 'high',
  `22->${r.clearlyLow}  47->${r.clearlyHigh}`);
T('one ride a degree off the edge is honestly a coin flip', r.oneRide29 === 'borderline',
  `29° vs band ${r.band[0]}–${r.band[1]}° -> "${r.oneRide29}"`);

T('the app no longer asks for a ride it will not use', r.poolsHistory, 'the fix ladder pools history');
T('two rides is not yet enough to settle it', r.two.rides === 2 && !r.two.settled, `rides=${r.two.rides} settled=${r.two.settled}`);
T('five agreeing rides settle where you actually ride',
  r.five.settled && r.five.verdict === 'borderline' && r.five.value < r.band[0],
  `${r.five.rides} rides, ${r.five.lo}–${r.five.hi}° -> ${r.five.value}° ±${r.five.u.toFixed(2)}°, just under ${r.band[0]}°`);
T('and pooling never claims more certainty than one ride allows',
  r.five.u >= r.floor / Math.sqrt(5) - 1e-9, `±${r.five.u.toFixed(2)}° vs floor/√5 = ±${(r.floor / Math.sqrt(5)).toFixed(2)}°`);
T('rides that agree well clear of the band get a prescription',
  r.fiveLow.verdict === 'low', `${r.fiveLow.value}° over ${r.fiveLow.rides} rides -> "${r.fiveLow.verdict}"`);
T('a single ride is never treated as settled', r.one.rides === 1 && !r.one.settled);

T('reported centre is the median', r.usesMedian, 'value: median(vals)');
T('badly-seen strokes excluded from the average', r.filtersByConfidence, 'conf >= minJointVisibility');
await b.close();
finish();
