/* The rule for every card in the app, held mechanically.
 *
 * A card's face (`means`) has to explain what the body is doing and what the
 * rider gets if it moves. Its working (`note`) has to be readable by someone
 * who has never seen a fit report. Neither may contain our vocabulary — no
 * "band", no "verdict withheld", no notes to ourselves about what we are
 * building next. The full rule is written above the card list in
 * js/analysis.js; this suite is what stops it drifting back.
 *
 * Written as a scanner rather than a regex over the source: the strings are a
 * mix of quoted and templated, and a regex that half-matches one would quietly
 * stop checking it. */
import { browser, BASE, T, finish } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage();
await page.goto(`${BASE}/index.html`);

const found = await page.evaluate(async () => {
  const files = {
    'js/analysis.js': await (await fetch('/js/analysis.js')).text(),
    'js/pages/analyze.js': await (await fetch('/js/pages/analyze.js')).text(),
  };

  /* Every string literal in the value of `key:`, not just the first one.
     The first version of this stopped at the opening quote and skipped any
     card whose text is assembled — `note: (both ? "a" : `b`) + "c"` — which
     is most of the front and rear cards, so the copy that most needed
     checking was the copy going unchecked. Walk to the end of the property
     instead, collecting literals as they come. */
  const strings = (src, key) => {
    const out = [];
    const re = new RegExp(`\\b${key}:\\s*`, 'g');
    let m;
    while ((m = re.exec(src))) {
      let i = m.index + m[0].length, depth = 0;
      for (; i < src.length; i++) {
        const ch = src[i];
        if (depth === 0 && (ch === ',' || ch === '}' || ch === ';')) break;   // end of value
        if ('([{'.includes(ch)) { depth++; continue; }
        if (')]}'.includes(ch)) { depth--; continue; }
        if (ch !== '"' && ch !== '`' && ch !== "'") continue;
        const q = ch;
        let buf = '', tpl = 0;
        for (i++; i < src.length; i++) {
          const c = src[i];
          if (c === '\\') { buf += c + src[i + 1]; i++; continue; }
          if (q === '`' && c === '$' && src[i + 1] === '{') { tpl++; i++; continue; }
          if (tpl) { if (c === '}') tpl--; else if (c === '{') tpl++; continue; }
          if (c === q) break;
          buf += c;
        }
        const text = buf.replace(/\s+/g, ' ').trim();
        if (text) out.push(text);
      }
    }
    return out;
  };

  /* The card faces and their working, plus the headline fix and the refusals
     — the fix is the most-read text in the report, so it lives under the same
     rule as everything else. */
  const all = [];
  for (const [file, src] of Object.entries(files))
    for (const key of ['means', 'note', 'caption', 'title', 'line', 'cue', 'why', 'gate'])
      for (const text of strings(src, key)) all.push({ file, key, text });
  return all;
});

/* Words that only mean something to whoever wrote the app. Each one has a
   plain replacement that carries exactly the same information. */
const SHOP_TALK = [
  [/\bbands?\b/i, 'say "the range riders sit in", not "the band"'],
  [/\bcited\b/i, 'a rider does not care whether we cited it'],
  [/\bverdicts?\b/i, 'say what we can or cannot tell them, not that a verdict is withheld'],
  [/\blandmarks?\b/i, 'joints, not landmarks'],
  [/\bconfidence\b/i, 'a confidence score means nothing to a rider'],
  [/\bgeometry\b/i, 'describe what was worked out, not that it was geometry'],
  [/\bpercentiles?\b/i, 'statistics vocabulary'],
  [/\bmedians?\b/i, 'statistics vocabulary'],
  [/\bprovisional\b/i, 'say why to trust it less, in words'],
  [/\bthe model\b/i, 'the rider does not know there is a model'],
  [/\bpose\b/i, 'internal'],
  [/\bocclu/i, 'internal'],
  [/\bkeyframes?\b/i, 'internal'],
  [/\bcomes next\b|\bfor now\b|\broadmap\b/i, 'a note to ourselves about what we are building'],
];

const offenders = [];
for (const s of found)
  for (const [re, why] of SHOP_TALK)
    if (re.test(s.text)) offenders.push(`${s.file} ${s.key}: "${s.text.match(re)[0]}" — ${why}`);

const count = (k) => found.filter((s) => s.key === k).length;
T('there is card copy to check', found.length >= 60,
  `${count('means')} meanings, ${count('note')} notes, ${count('caption')} captions, ${found.length - count('means') - count('note') - count('caption')} lines of the fix and the refusals`);
T('no card speaks our language instead of the rider\'s', offenders.length === 0,
  offenders.slice(0, 4).join(' | ') || 'nothing to translate');

/* The face of a card has a job: say what the body is doing, and say what the
   rider gets if it changes. A card naming neither is a fact filed at someone. */
const MECHANICS = /\b(quads?|glutes?|hamstrings?|calf|calves|muscles?|tendons?|load|power|weight|effort|work|heart|lungs?|hip flexors?)\b/i;
const means = found.filter((s) => s.key === 'means');

const thin = means.filter((s) => s.text.length < 180);
T('every card face is written out, not stubbed',
  thin.length === 0, thin.map((s) => `"${s.text.slice(0, 40)}…" (${s.text.length} chars)`).join(' | ') || `${means.length} faces, shortest ${Math.min(...means.map((s) => s.text.length))} chars`);

const noMechanics = means.filter((s) => !MECHANICS.test(s.text));
T('every card face says what the body is actually doing',
  noMechanics.length === 0,
  noMechanics.map((s) => `"${s.text.slice(0, 50)}…"`).join(' | ') || 'muscles, load or effort named in all ' + means.length);

const notAddressed = means.filter((s) => !/\byou\b|\byour\b/i.test(s.text));
T('and says it to the rider, not about riders in general',
  notAddressed.length === 0, notAddressed.map((s) => `"${s.text.slice(0, 50)}…"`).join(' | ') || 'second person throughout');

const oneSentence = means.filter((s) => (s.text.match(/[.!?](\s|$)/g) || []).length < 2);
T('and does not stop at the anatomy — what changes if it moves comes next',
  oneSentence.length === 0, oneSentence.map((s) => `"${s.text.slice(0, 50)}…"`).join(' | ') || 'every face carries both halves');

// The rule has to be written down where the next person will find it.
const ruleWritten = await page.evaluate(async () => {
  const src = await (await fetch('/js/analysis.js')).text();
  return /HOW A CARD IS WRITTEN/.test(src) && /card-language\.test\.mjs/.test(src);
});
T('the rule is written above the cards, and points at this suite', ruleWritten);

await b.close();
finish();
