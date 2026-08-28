/* The report's job is not to file measurements at a rider. Two rules this
   suite holds: every card says what it means for the riding before it says
   what was measured, and the working is one tap away rather than in the way.
   Plus the player: three angles, and controls on it. */
import { browser, BASE, T, finish } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const c = await b.newContext({ viewport: { width: 393, height: 852 }, permissions: ['camera'] });
const page = await c.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${BASE}/#/login`);
await page.waitForSelector('#send');

// --- every shipped card carries a meaning -----------------------------------
const src = await page.evaluate(async () => ({
  analysis: await (await fetch('/js/analysis.js')).text(),
  page: await (await fetch('/js/pages/analyze.js')).text(),
}));
const cardNames = [...src.analysis.matchAll(/name: "([^"]+)"/g), ...src.page.matchAll(/name: "([^"]+)"/g)]
  .map((m) => m[1]);
const meansCount = (src.analysis.match(/means:/g) || []).length + (src.page.match(/means:/g) || []).length;
T('every measurement card has a meaning written for it',
  meansCount >= cardNames.length, `${meansCount} meanings for ${cardNames.length} cards`);

// --- render a report and check the hierarchy --------------------------------
const shape = await page.evaluate(async () => {
  const { drawReport } = await import('/js/pages/analyze.js');
  const cv = document.createElement('canvas'); cv.width = 400; cv.height = 300;
  cv.getContext('2d').fillStyle = '#555'; cv.getContext('2d').fillRect(0, 0, 400, 300);
  const shot = { src: cv.toDataURL('image/jpeg', 0.7), drawn: true, caption: 'the frame it came from' };
  drawReport(document.getElementById('view'), {
    strokes: 14, cadence: 85, trim: [0, 2], keyframes: [shot], viewsCaptured: ['side'],
    fix: { title: 'Saddle looks high', line: 'l', cue: 'c', why: 'w' },
    cards: [
      { name: "Knee at 6 o'clock", value: '29°', verdict: 'Watch', shot,
        means: 'This one setting decides where your power comes from and where the load goes.',
        note: 'Band 30-40 degrees, plus or minus 3.2 across 14 strokes.' },
      { name: 'Cadence', value: '85 rpm', verdict: 'OK',
        means: 'Spinning faster shifts effort off your legs and onto your heart and lungs.',
        note: 'Research sweet spot 75-95 rpm.' },
    ],
  }, null);
  await new Promise((r) => setTimeout(r, 200));

  const cards = [...document.querySelectorAll('.mcard')];
  const first = cards[0];
  const meansBox = first.querySelector('.means').getBoundingClientRect();
  const noteHidden = first.querySelector('.mbody').hidden;
  first.querySelector('.mhead').click();
  await new Promise((r) => setTimeout(r, 120));
  return {
    cards: cards.length,
    allHaveMeans: cards.every((el) => el.querySelector('.means')?.textContent.trim().length > 30),
    meansVisible: meansBox.height > 0,
    numbersHiddenAtFirst: noteHidden,
    opensOnTap: !first.querySelector('.mbody').hidden,
    aria: first.querySelector('.mhead').getAttribute('aria-expanded'),
    shotAppearsOnOpen: !!first.querySelector('.mbody img'),
    cadenceHasNoShot: !cards[1].querySelector('img'),
    // the toggle names what you get
    toggles: cards.map((el) => el.querySelector('.mtoggle').textContent.replace(/[▾\s]+$/, '')),
    tapTarget: first.querySelector('.mhead').getBoundingClientRect().height,
  };
});

T('cards render with their meaning on the face', shape.allHaveMeans && shape.meansVisible, `${shape.cards} cards`);
T('the numbers start hidden, not in the way', shape.numbersHiddenAtFirst);
T('tapping opens the working', shape.opensOnTap && shape.aria === 'true');
T('and that is where the frame lives', shape.shotAppearsOnOpen);
T('a card with nothing to show offers no picture', shape.cadenceHasNoShot);
T('the toggle says what tapping gives you',
  shape.toggles[0] === 'See it on your ride' && shape.toggles[1] === 'See the numbers', shape.toggles.join(' / '));
T('the whole header is the tap target', shape.tapTarget >= 44, `${shape.tapTarget.toFixed(0)}px`);

// --- the player: three angles and its tools ---------------------------------
const player = await page.evaluate(async () => {
  const { drawReport } = await import('/js/pages/analyze.js');
  const clip = async () => {
    const cv = document.createElement('canvas'); cv.width = 320; cv.height = 240;
    const g = cv.getContext('2d');
    const rec = new MediaRecorder(cv.captureStream(30), { videoBitsPerSecond: 2_000_000 });
    const parts = []; rec.ondataavailable = (e) => parts.push(e.data);
    rec.start();
    const t0 = performance.now();
    await new Promise((done) => {
      const tick = () => {
        g.fillStyle = '#0a6'; g.fillRect(0, 0, 320, 240);
        if (performance.now() - t0 < 1500) requestAnimationFrame(tick); else done();
      };
      tick();
    });
    await new Promise((res) => { rec.onstop = res; rec.stop(); });
    return new Blob(parts, { type: parts[0]?.type || 'video/webm' });
  };
  const clips = { side: await clip(), front: await clip(), rear: await clip() };

  const j = { hip: {x:.5,y:.35}, knee: {x:.55,y:.55}, ankle: {x:.52,y:.75}, sho: {x:.45,y:.2} };
  const side = Array.from({ length: 18 }, (_, i) => ({ t: i / 12, knee: 30 + i, j }));
  const front = Array.from({ length: 18 }, (_, i) => ({ t: i / 12, left: 5, right: 7,
    j: { lknee: {x:.4,y:.5}, lankle: {x:.41,y:.75}, rknee: {x:.6,y:.5}, rankle: {x:.59,y:.75} } }));
  const rear = Array.from({ length: 18 }, (_, i) => ({ t: i / 12, shoulder: 2, pelvis: 4,
    j: { lsho: {x:.4,y:.3}, rsho: {x:.6,y:.32}, lhip: {x:.44,y:.6}, rhip: {x:.56,y:.62} } }));

  drawReport(document.getElementById('view'), {
    strokes: 14, cadence: 85, trim: [0, 1.4], track: side, keyframes: [], viewsCaptured: ['side', 'front', 'rear'],
    front: { track: front, trim: [0, 1.4], kneeTravel: { left: 5, right: 7 } },
    rear: { track: rear, trim: [0, 1.4], pelvicRock: 4 },
    fix: { title: 'Saddle looks high', line: 'l', cue: 'c', why: 'w' },
    cards: [{ name: 'Cadence', value: '85 rpm', means: 'Spinning faster shifts effort to your heart and lungs.', note: 'n' }],
  }, clips);
  await new Promise((r) => setTimeout(r, 900));

  const tabs = [...document.querySelectorAll('.angletabs button')];
  const tools = [...document.querySelectorAll('.mv-tools .tool')];
  const beforeSrc = document.getElementById('mv').currentSrc;
  tabs[1].click();
  await new Promise((r) => setTimeout(r, 700));
  const afterSrc = document.getElementById('mv').currentSrc;
  const capAfter = document.getElementById('mvcap').textContent;

  // lines toggle
  const linesBtn = document.getElementById('mvlines');
  const onBefore = linesBtn.classList.contains('on');
  linesBtn.click();
  const onAfter = linesBtn.classList.contains('on');
  linesBtn.click();

  return {
    tabs: tabs.map((t) => t.textContent),
    activeAfterSwitch: tabs[1].classList.contains('on') && !tabs[0].classList.contains('on'),
    clipChanged: beforeSrc !== afterSrc && !!afterSrc,
    capChanged: capAfter,
    // strip the icon glyph, keep the label
    tools: tools.map((t) => t.textContent.replace(/[^A-Za-z ]/g, '').trim()),
    toolTargets: tools.every((t) => t.getBoundingClientRect().height >= 44),
    linesTogglable: onBefore === true && onAfter === false,
  };
});

T('the player offers all three angles', player.tabs.join(',') === 'Side,Front,Behind', player.tabs.join(' · '));
T('switching angle loads that clip', player.clipChanged && player.activeAfterSwitch);
T('and says what that angle is showing you', /plumb line/.test(player.capChanged), `"${player.capChanged.slice(0, 46)}…"`);
T('lines, save and coach sit on the player', player.tools.join(',') === 'Lines,Save frame,Coach', player.tools.join(' · '));
T('the tools are thumb-sized', player.toolTargets);
T('lines can be turned off to see the rider underneath', player.linesTogglable);
// Video-derived joint positions never leave the phone — for every view.
const stripping = await page.evaluate(async () => {
  const src = await (await fetch('/js/pages/analyze.js')).text();
  return {
    stripsAll: /front: strip\(top\.front\), rear: strip\(top\.rear\)/.test(src),
    stripsTop: /const \{ keyframes, track, \.\.\.top \} = report;/.test(src),
  };
});
T('front and rear tracks are stripped before the insert too, not just the side one',
  stripping.stripsAll && stripping.stripsTop, 'every view\'s per-frame joints stay on the phone');

// Leaving the report must stop the video and the frame loop.
const leak = await page.evaluate(async () => {
  const src = await (await fetch('/js/pages/analyze.js')).text();
  return {
    kept: /state\.disposePlayer = drawReport\(/.test(src),
    called: /state\.disposePlayer\?\.\(\)/.test(src),
  };
});
T('the player is torn down when you leave the report', leak.kept && leak.called,
  'its teardown was being returned and dropped');

T('no page errors through any of it', errs.length === 0, errs.join(' | ') || 'clean');
await b.close();
finish();
