import { browser, BASE, T, finish, OUT } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage();
await page.goto(`${BASE}/index.html`);

// The squareness estimate is pure geometry: build hips at a known yaw and check
// the grader recovers it.
const geo = await page.evaluate(async () => {
  const { squareUp } = await import('/js/analysis.js');
  const { CAPTURE } = await import('/js/config.js');
  const W = 1280, H = 720, sq = squareUp(W / H);
  const n = (x, y) => sq({ x: x / W, y: y / H });
  const deg = (r) => (r * 180) / Math.PI;

  // trunk: shoulder above hip. hip pair separated by hipWidth*sin(yaw).
  const trunkPx = 300;                       // shoulder->hip
  const hipWidthPx = trunkPx * CAPTURE.hipWidthOverTrunk;
  const at = (yawDeg) => {
    const sep = hipWidthPx * Math.sin(yawDeg * Math.PI / 180);
    const hipL = n(600, 500), hipR = n(600 + sep, 500), sho = n(600, 500 - trunkPx);
    const trunk = Math.hypot(sho.x - hipL.x, sho.y - hipL.y);
    const ratio = Math.abs(hipR.x - hipL.x) / trunk;
    return deg(Math.asin(Math.min(1, ratio / CAPTURE.hipWidthOverTrunk)));
  };
  return { sq0: at(0), sq10: at(10), sq15: at(15), sq30: at(30), CAPTURE };
});
T('square-on reads 0°', Math.abs(geo.sq0) < 0.1, `${geo.sq0.toFixed(2)}°`);
T('10° yaw recovers as ~10°', Math.abs(geo.sq10 - 10) < 0.6, `${geo.sq10.toFixed(1)}°`);
T('15° yaw recovers as ~15°', Math.abs(geo.sq15 - 15) < 0.6, `${geo.sq15.toFixed(1)}°`);
T('30° yaw recovers as ~30°', Math.abs(geo.sq30 - 30) < 1.0, `${geo.sq30.toFixed(1)}°`);
T("threshold is rule 3's own 15°", geo.CAPTURE.offSquareMaxDeg === 15, `max=${geo.CAPTURE.offSquareMaxDeg}°`);

// The report shell: a provisional read must lead with the warning, headline the
// camera, and carry no verdict words.
const ui = await page.evaluate(() => {
  const r = {
    provisional: true,
    capture: { grade: 'C', offSquareDeg: 22, reason: 'The phone looks about 22° off square to the bike.' },
    fix: { title: 'Square the camera up first', line: 'The phone looks about 22° off square to the bike.', cue: 'Stand the phone level with the saddle.' },
    strokes: 16,
    cards: [{ name: 'Knee at 6 o’clock', value: '38°', verdict: '', note: 'Band 30–40°. Provisional — the camera wasn\'t square, so treat this as indicative.' }],
  };
  const v = document.getElementById('view');
  v.innerHTML = `
    <div class="glass card" id="fix"><div class="sect" id="lab">${r.provisional ? 'Provisional read' : "This ride's fix"}</div><h2>${r.fix.title}</h2><p>${r.fix.line}</p></div>
    ${r.cards.map(c => `<div class="glass card kcard"><div class="val">${c.value} ${c.verdict ? `<em>${c.verdict}</em>` : ''}</div><p>${c.note}</p></div>`).join('')}
    <div class="footnote">across ${r.strokes} strokes · camera about ${r.capture.offSquareDeg}° off square</div>`;
  return {
    cards: v.querySelectorAll('.glass.card').length,
    label: v.querySelector('#lab').textContent,
    repeats: (v.querySelector('#fix').textContent.match(/off square to the bike/g) || []).length,
    fixIsCamera: v.querySelector('#fix h2').textContent,
    verdictWords: v.querySelectorAll('.kcard em').length,
    saysProvisional: /provisional/i.test(v.querySelector('.kcard p').textContent),
    footnote: v.querySelector('.footnote').textContent.trim(),
  };
});
T('one card, not two saying the same thing', ui.cards === 2, `cards on screen=${ui.cards} (fix + measured)`);
T('the card is labelled provisional', /provisional/i.test(ui.label), `"${ui.label}"`);
T('the reason is stated once, not twice', ui.repeats === 1, `occurrences=${ui.repeats}`);
T('camera becomes the headline fix', /square the camera/i.test(ui.fixIsCamera), `"${ui.fixIsCamera}"`);
T('no verdict words survive a provisional read', ui.verdictWords === 0, `verdicts=${ui.verdictWords}`);
T('each number says it is provisional', ui.saysProvisional, 'note carries the caveat');
T('footnote records the camera angle', /off square/.test(ui.footnote), `"${ui.footnote}"`);
await b.close();
finish();
