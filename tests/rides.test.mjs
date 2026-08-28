/* Rides from Strava, and the discipline around them. The danger with this
   data is not that the maths is wrong — it is that a fit app will happily
   announce it found you twelve watts. */
import { browser, BASE, T, finish } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage();
await page.goto(`${BASE}/index.html`);

const r = await page.evaluate(async () => {
  const R = await import('/js/rides.js');
  const C = await import('/js/pages/coach.js');

  const day = 86400000;
  const at = Date.parse('2026-06-01T10:00:00Z');
  const ride = (offsetDays, o = {}) => ({
    start_time: new Date(at + offsetDays * day).toISOString(),
    indoor: true, moving_s: 3600, device_watts: true,
    avg_watts: 200, avg_hr: 150, avg_cadence: 88, ...o,
  });

  // six weeks either side, power clearly up afterwards
  const before = [-30, -24, -18, -12, -6].map((d) => ride(d, { avg_watts: 200 + (d % 3) }));
  const after = [3, 9, 15, 21, 27].map((d) => ride(d, { avg_watts: 230 + (d % 3) }));
  const change = { changed_at: new Date(at).toISOString(), part: 'Saddle down 5 mm' };

  const clear = R.aroundChange([...before, ...after], change);
  const power = clear.shifts.find((s) => s.metric === 'avg_watts');

  // same medians, but wildly variable rides: must NOT be called a change
  const noisyB = [-30, -24, -18, -12, -6].map((d, i) => ride(d, { avg_watts: [120, 280, 150, 260, 200][i] }));
  const noisyA = [3, 9, 15, 21, 27].map((d, i) => ride(d, { avg_watts: [130, 290, 160, 270, 210][i] }));
  const noisy = R.aroundChange([...noisyB, ...noisyA], change)
    .shifts.find((s) => s.metric === 'avg_watts');

  // too few rides
  const thin = R.aroundChange([ride(-5), ride(4)], change).shifts.find((s) => s.metric === 'avg_watts');

  // outdoor rides must not be mixed with indoor ones
  const mixed = R.comparable([ride(-5), ride(-4, { indoor: false }), ride(3)], { indoor: true });
  // short rides are not comparable to hour-long ones
  const shortOnes = R.comparable([ride(-5, { moving_s: 300 }), ride(-4)], { indoor: true });

  // estimated power must not be treated as measured
  const est = R.aroundChange(
    [...before.map((x) => ({ ...x, device_watts: false })), ...after.map((x) => ({ ...x, device_watts: false }))],
    change).shifts.find((s) => s.metric === 'avg_watts');

  // the coach must never receive platform ride data
  const payload = C.stripPlatformData({
    fix: { title: 'Saddle looks high' },
    kneeBendBDC: { value: 29 },
    rides: [{ avg_watts: 240, distance_m: 40000 }],
    nested: { strava: { athlete_id: '123' }, avg_hr: 150, keep: 'yes' },
  });

  return {
    clearDelta: power.clear && Math.round(power.delta),
    clearN: [power.before, power.after],
    noisyClear: noisy.clear,
    noisyDelta: Math.round(noisy.delta),
    thinEnough: thin.enough, thinShort: thin.short,
    mixed: mixed.length, shortOnes: shortOnes.length,
    estEnough: est.enough,
    confounds: R.aroundChange([...before, ...after], change).confounds.length,
    lastConfound: R.aroundChange([...before, ...after], change).confounds.at(-1),
    payloadKeys: Object.keys(payload),
    payloadNested: Object.keys(payload.nested),
    keptFix: payload.fix?.title,
    json: JSON.stringify(payload),
  };
});

T('a real, consistent shift is reported', r.clearDelta === 30, `+${r.clearDelta} W from ${r.clearN[0]} rides to ${r.clearN[1]}`);
T('the same shift buried in noise is NOT called a change',
  r.noisyClear === false, `delta was ${r.noisyDelta} W but inside the rides' own spread`);
T('too few rides gives no answer at all', r.thinEnough === false, `needs ${r.thinShort}`);
T('outdoor rides are not compared against indoor ones', r.mixed === 2, `${r.mixed} of 3 kept`);
T('short rides are not compared against long ones', r.shortOnes === 1, `${r.shortOnes} of 2 kept`);
T('estimated power is not treated as measured', r.estEnough === false, 'rides without a power meter are excluded');
T('confounds are always listed, never omitted', r.confounds >= 2, `${r.confounds} listed`);
T('and the last word is that this is not causation', /not what the change did/.test(r.lastConfound));

T('ride data never reaches the coach payload',
  !r.payloadKeys.includes('rides') && !r.payloadNested.includes('avg_hr') && !r.payloadNested.includes('strava'),
  `top=${r.payloadKeys.join(',')} nested=${r.payloadNested.join(',')}`);
T('and nothing platform-shaped survives anywhere in it',
  !/avg_watts|avg_hr|strava|distance_m/.test(r.json), r.json.slice(0, 80));
T('while the fit report itself is left intact', r.keptFix === 'Saddle looks high');
await b.close();
finish();
