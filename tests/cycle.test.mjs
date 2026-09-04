/* The stroke as a periodic function of crank angle.
 *
 * Reading the knee off the one frame where the ankle was lowest carries that
 * frame's whole error, and the frame is chosen BY the noise. Fitting a short
 * Fourier series to every frame and evaluating it at exactly bottom-dead-
 * centre uses two hundred samples for the one number and has no favourite
 * frame to lean on. */
import { browser, BASE, T, finish } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage();
await page.goto(`${BASE}/index.html`);

const r = await page.evaluate(async () => {
  const C = await import('/js/cycle.js');

  /* One estimator against another is a question about their error over many
     rides, not one lucky seed. Simulate the same rider thirty times with
     fresh noise and compare root-mean-square error at bottom-dead-centre. */
  const FPS = 15, RPM = 88, N = Math.round(14 * FPS);
  const truth = (th) => 73 - 40 * Math.sin(th) + 4 * Math.cos(2 * th);
  const centre = { cx: 0.50, cy: 0.70 }, R = 0.09;

  const ride = (seed) => {
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const times = [], knee = [], pts = [];
    for (let i = 0; i < N; i++) {
      const t = i / FPS, th = (t * RPM / 60) * 2 * Math.PI - Math.PI / 2;
      times.push(t);
      knee.push(truth(th) + 3 * gauss());
      pts.push({ x: centre.cx + R * Math.cos(th) + 0.003 * gauss(), y: centre.cy + R * Math.sin(th) + 0.003 * gauss() });
    }
    const ang = C.crankAngles(pts, centre);
    const fit = C.harmonic(ang, knee, 3);
    const cad = C.cadenceFrom(ang, times);
    const bdcFrames = C.framesAt(ang, C.BDC);
    const perStroke = bdcFrames.map((i) => knee[i]).sort((a, b) => a - b);
    /* The same ride with the model's real failure mode added: one frame in
       sixteen has the knee forty degrees out, as when it lands on the other
       leg. A least-squares curve leans towards those; a robust one sets them
       aside and should read as if they were never there. */
    const dirty = knee.map((v) => (rnd() < 1 / 16 ? v + 40 : v));
    const robust = C.harmonic(ang, dirty, 3);
    const plain = C.harmonic(ang, dirty, 3, { robust: false });
    const boot = C.bootstrapAt(ang, knee, C.BDC, { B: 100 });
    return {
      fitErr: fit.at(C.BDC) - truth(C.BDC),
      topErr: fit.at(C.TDC) - truth(C.TDC),
      dirtyRobustErr: robust.at(C.BDC) - truth(C.BDC),
      dirtyPlainErr: plain.at(C.BDC) - truth(C.BDC),
      outliers: robust.outliers, injected: dirty.filter((v, i) => v !== knee[i]).length,
      cleanOutliers: fit.outliers,
      se: boot?.se ?? NaN, bootRevs: boot?.revolutions ?? 0,
      oneFrameErr: perStroke[perStroke.length >> 1] - truth(C.BDC),
      rpm: cad.rpm, revs: cad.revolutions, strokes: bdcFrames.length, fitSd: fit.sd,
      unwrapped: ang.every((a, i) => i === 0 || a >= ang[i - 1] - 1e-9),
    };
  };
  const runs = Array.from({ length: 30 }, (_, i) => ride(7 + i * 101));
  const rms = (k) => Math.sqrt(runs.reduce((s, q) => s + q[k] ** 2, 0) / runs.length);
  const meanOf = (k) => runs.reduce((s, q) => s + q[k], 0) / runs.length;
  return {
    rmsFit: rms('fitErr'), rmsTop: rms('topErr'), rmsOne: rms('oneFrameErr'),
    rmsDirtyRobust: rms('dirtyRobustErr'), rmsDirtyPlain: rms('dirtyPlainErr'),
    caught: meanOf('outliers'), injected: meanOf('injected'), cleanDropped: meanOf('cleanOutliers'),
    // calibration: the bootstrap's claimed uncertainty against the error actually made
    meanSe: meanOf('se'), bootRevs: runs[0].bootRevs,
    rpm: runs[0].rpm, revs: runs[0].revs, strokes: runs[0].strokes, fitSd: runs[0].fitSd,
    unwrapped: runs.every((q) => q.unwrapped),
    // theory: σ·√(params/frames)·~1.2 at the extreme, for 3° noise, 7 params, 210 frames
    expected: 3 * Math.sqrt(7 / N) * 1.2,
  };
});

T('the crank angle climbs without jumps across every revolution', r.unwrapped);
T('cadence comes off every frame at once, to within a beat',
  Math.abs(r.rpm - 88) < 0.5, `${r.rpm.toFixed(2)} rpm over ${r.revs.toFixed(1)} revolutions`);
T('the fitted curve lands within a degree of the true bottom-of-stroke angle, ride after ride',
  r.rmsFit < 1.0, `RMS error ${r.rmsFit.toFixed(2)}° over 30 rides, from 3° of per-frame noise (theory says about ${r.expected.toFixed(2)}°)`);
T('and of the true top-of-stroke angle', r.rmsTop < 1.0, `RMS ${r.rmsTop.toFixed(2)}°`);
T('closer than reading one frame per stroke, on the same rides',
  r.rmsFit < r.rmsOne,
  `one frame per stroke: RMS ${r.rmsOne.toFixed(2)}°; the fit: ${r.rmsFit.toFixed(2)}°`);
T('the residual reports the noise that was actually in the frames',
  r.fitSd > 2.4 && r.fitSd < 3.6, `${r.fitSd.toFixed(2)}° against 3° put in`);
T('and it still knows which frames are the bottom of each stroke, for the picture',
  r.strokes >= 19 && r.strokes <= 22, `${r.strokes} strokes found in 14 s at 88 rpm`);
T('a frame in sixteen forty degrees out barely moves the robust curve',
  r.rmsDirtyRobust < 1.0, `RMS ${r.rmsDirtyRobust.toFixed(2)}° with misreads, ${r.rmsFit.toFixed(2)}° without`);
T('where a plain least-squares fit is pulled towards them',
  r.rmsDirtyPlain > r.rmsDirtyRobust * 1.5, `plain RMS ${r.rmsDirtyPlain.toFixed(2)}°`);
T('it sets aside about as many frames as were misread, and few honest ones',
  r.caught >= r.injected * 0.8 && r.caught <= r.injected + 6,
  `${r.caught.toFixed(1)} set aside, ${r.injected.toFixed(1)} injected`);
T('and on a clean ride it drops almost nothing', r.cleanDropped <= 4, `${r.cleanDropped.toFixed(1)} frames`);
T('the resampled uncertainty is calibrated: it claims about the error that is made',
  r.meanSe > r.rmsFit * 0.6 && r.meanSe < r.rmsFit * 1.7,
  `claims ±${r.meanSe.toFixed(2)}°, actual RMS ${r.rmsFit.toFixed(2)}° over ${r.bootRevs} revolutions`);


await b.close();
finish();
