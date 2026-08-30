/* The fix card is the first thing a rider meets after their own footage.
 *
 * It shipped as sixteen unbroken lines: a headline, a four-line finding, a
 * five-line instruction and a seven-line explanation, all at once, above the
 * numbers. Depth was never the problem — depth arriving before anyone asked
 * for it is. Every measurement card on this screen opens on a sentence and
 * folds its working away; this one is the card that most needs to do that. */
import { browser, BASE, T, finish } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const c = await b.newContext({ viewport: { width: 393, height: 852 } });
const page = await c.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${BASE}/index.html`);

const shape = await page.evaluate(async () => {
  const { drawReport } = await import('/js/pages/analyze.js');
  drawReport(document.getElementById('view'), {
    strokes: 20, cadence: 85, trim: [0, 2], keyframes: [], viewsCaptured: ['side'],
    fix: {
      title: 'Film it the same way twice',
      line: 'Your knee has read anywhere from 27° to 39° across 9 rides. Your saddle did not move that much — the camera did.',
      cue: 'Phone at saddle height, square to the side of the bike, same spot every time.',
      why: 'That spread is wider than the whole 30–40° window we are trying to place you in, which means the reads disagree rather than that you ride inconsistently. It is worth the ten minutes because everything else waits on it.',
    },
    cards: [{ name: 'Cadence', value: '85 rpm', means: 'Spinning faster shifts the effort off your legs and onto your heart and lungs.', note: 'n' }],
  }, null);
  await new Promise((r) => setTimeout(r, 150));

  const card = document.querySelector('.card');
  const why = document.getElementById('fixwhy');
  const more = document.querySelector('.fixmore');
  /* textContent counts hidden nodes, so measure what is actually on the face:
     everything in the card minus the panel that is folded away. */
  const face = () => {
    const all = card.textContent.replace(/\s+/g, ' ').trim();
    const hidden = why.hidden ? why.textContent.replace(/\s+/g, ' ').trim() : '';
    return hidden ? all.replace(hidden, '').replace(/\s+/g, ' ').trim() : all;
  };

  const closedText = face();
  const closedHeight = card.getBoundingClientRect().height;
  more.click();
  await new Promise((r) => setTimeout(r, 120));

  return {
    closedText,
    closedHeight,
    hidesTheWhyAtFirst: !closedText.includes('worth the ten minutes'),
    showsFinding: closedText.includes('27° to 39°'),
    showsInstruction: closedText.includes('Phone at saddle height'),
    opensOnTap: !why.hidden && more.getAttribute('aria-expanded') === 'true',
    openText: card.textContent.replace(/\s+/g, ' ').trim(),
    tapTarget: more.getBoundingClientRect().height,
    prescriptions: document.querySelectorAll('.card .try').length,
    hasLogButton: !!document.getElementById('madeit'),
  };
});

T('the fix opens on what we found and what to do, nothing else',
  shape.hidesTheWhyAtFirst && shape.showsFinding && shape.showsInstruction,
  `${shape.closedText.length} characters on the face`);

/* A number rather than a feeling: the whole closed card has to be readable
   without scrolling past it. Two short sentences and a toggle is about 300
   characters; the version that prompted this was over 900. */
T('and it is short enough to read before scrolling',
  shape.closedText.length < 420 && shape.closedHeight < 340,
  `${shape.closedText.length} chars, ${Math.round(shape.closedHeight)}px tall`);

T('the reasoning is one tap away, not gone', shape.opensOnTap &&
  shape.openText.includes('worth the ten minutes'), 'What that gets you');
T('the toggle is thumb-sized', shape.tapTarget >= 24, `${Math.round(shape.tapTarget)}px`);
T('still exactly one prescription on the screen', shape.prescriptions === 1);
T('and still a way to say you made the change', shape.hasLogButton);
T('no page errors', errs.length === 0, errs.join(' | ') || 'clean');

await b.close();

/* Each fix branch has to keep to the shape: one sentence found, one to do. */
{
  const whole = await (await fetch(`${BASE}/js/analysis.js`)).text();
  /* The report's fix only. The home screen's standing lines are a different
     component with a different budget — they carry the mechanics, which is the
     whole point of them — and scanning the file rather than the block quietly
     applied the fix card's one-sentence rule to them. */
  const src = whole.slice(whole.indexOf('  let fix;'), whole.indexOf('/* The picture has to be of the stroke'));
  const grab = (key) => [...src.matchAll(new RegExp(String.raw`\b${key}: (\`[^\`]*\`|"[^"]*")`, 'g'))]
    .map((m) => m[1].slice(1, -1).replace(/\$\{[^{}]*(\{[^{}]*\})?[^{}]*\}/g, '00').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const over = (key, cap) => grab(key).filter((t) => t.length > cap).map((t) => `${t.slice(0, 55)}… (${t.length})`);
  const lines = over('line', 190), cues = over('cue', 130);
  T('every fix states its finding in a sentence', grab('line').length >= 5 && lines.length === 0,
    lines.join(' | ') || `${grab('line').length} findings, longest ${Math.max(...grab('line').map((t) => t.length))} characters`);
  T('and its instruction in a sentence', grab('cue').length >= 5 && cues.length === 0,
    cues.join(' | ') || `${grab('cue').length} instructions, longest ${Math.max(...grab('cue').map((t) => t.length))} characters`);
  finish();
}
