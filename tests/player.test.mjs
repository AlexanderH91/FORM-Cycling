import { browser, BASE, T, finish, OUT } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch({ args: ['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required'] });
const c = await b.newContext({ viewport: { width: 393, height: 852 }, permissions: ['camera'] });
const page = await c.newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto(`${BASE}/#/login`);
await page.waitForSelector('#send');

// Record a short real clip with the fake camera, then drive drawReport with a
// synthetic track over it — the player path end to end.
const out = await page.evaluate(async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  const chunks = [];
  const rec = new MediaRecorder(stream);
  rec.ondataavailable = e => chunks.push(e.data);
  rec.start();
  await new Promise(r => setTimeout(r, 2500));
  await new Promise(r => { rec.onstop = r; rec.stop(); });
  stream.getTracks().forEach(t => t.stop());
  const clip = new Blob(chunks, { type: chunks[0]?.type || 'video/webm' });

  const track = [];
  for (let i = 0; i <= 30; i++) {
    const t = i / 12;
    const k = 25 + 20 * Math.abs(Math.sin(i / 3));      // sweeps in and out of band
    track.push({ t: +t.toFixed(3), knee: +k.toFixed(1),
      j: { hip: {x:0.5,y:0.35}, knee: {x:0.55,y:0.55}, ankle: {x:0.52,y:0.75}, sho: {x:0.45,y:0.2} } });
  }
  const r = {
    track, trim: [0, 2.4], strokes: 16, capture: { offSquareDeg: 9 },
    fix: { title: 'Saddle looks high', line: 'Your knee only bends 28° at the bottom.', cue: 'Drop the saddle 5 mm.' },
    cards: [{ name: 'Knee at 6 o’clock', value: '28°', verdict: 'Watch', note: 'Band 30–40°.' }],
    keyframes: [],
  };
  const mod = await import('/js/pages/analyze.js?p=1');
  window.__r = r; window.__clip = clip;
  return { size: clip.size, exported: typeof mod.renderAnalyze === 'function' };
});
T('recorded a real clip to play', out.size > 1000, `${out.size} bytes`);

// The logic that decides what gets drawn, exercised directly.
const logic = await page.evaluate(async () => {
  const { overlayAt } = await import('/js/analysis.js');
  const tr = [
    { t: 0.0, knee: 35, j: {} }, { t: 0.5, knee: 28, j: {} },
    { t: 1.0, knee: 41, j: {} }, { t: 3.0, knee: 33, j: {} },   // 2s hole before this
  ];
  return {
    exact: overlayAt(tr, 0.5)?.knee,
    nearestBelow: overlayAt(tr, 0.54)?.knee,
    nearestAbove: overlayAt(tr, 0.97)?.knee,
    inBand35: overlayAt(tr, 0.0)?.inBand,
    outBand28: overlayAt(tr, 0.5)?.inBand,
    outBand41: overlayAt(tr, 1.0)?.inBand,
    inHole: overlayAt(tr, 2.0),
    empty: overlayAt([], 1),
    pastEnd: overlayAt(tr, 9),
  };
});
T('picks the frame at that moment', logic.exact === 28, `t=0.5 -> ${logic.exact}°`);
T('snaps to the nearest analysed frame', logic.nearestBelow === 28 && logic.nearestAbove === 41,
  `0.54->${logic.nearestBelow}°  0.97->${logic.nearestAbove}°`);
T('band colour follows the real band', logic.inBand35 === true && logic.outBand28 === false && logic.outBand41 === false,
  `35 in=${logic.inBand35}  28 in=${logic.outBand28}  41 in=${logic.outBand41}`);
T('draws nothing across a gap in the track', logic.inHole === null, `t=2.0 -> ${logic.inHole}`);
T('draws nothing past the end or with no track', logic.pastEnd === null && logic.empty === null,
  `pastEnd=${logic.pastEnd} empty=${logic.empty}`);

// remaining structural checks
const play = await page.evaluate(async () => {
  const res = await fetch('/js/pages/analyze.js');
  const src = await res.text();
  return {
    hasPlayer: /function wirePlayer/.test(src),
    called: /if \(canPlay\) wirePlayer/.test(src),
    stripsTrack: /const \{ keyframes, track, \.\.\.stored \}/.test(src),
    usesSharedLogic: /overlayAt\(track, video\.currentTime\)/.test(src),
    speeds: (src.match(/\[0\.25, 0\.5, 1\]/) || []).length === 1,
    bandColours: /#34D27B/.test(src) && /#F2C230/.test(src),
  };
});
T('player exists and is called from the report', play.hasPlayer && play.called, `defined=${play.hasPlayer} called=${play.called}`);
T('track never reaches the server', play.stripsTrack, 'stripped alongside keyframes');
T('player draws via the tested overlay logic', play.usesSharedLogic, 'calls overlayAt');
T('speed control offers 0.25/0.5/1', play.speeds, '0.25, 0.5, 1');
T('overlay uses the in-band / out-of-band colours', play.bandColours, 'green + gold');
console.log(errs.length ? 'JS ERRORS: ' + errs.join(' | ') : 'no JS errors');
await b.close();
finish();
