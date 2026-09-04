/* A week of reports said "re-read with the heavy model" while no frame was.
   The cause was one line: `const spread = pooled.hi - pooled.lo` inside the
   analysis function, which shadowed the module-level spread() that the refine
   pass calls and left it in the temporal dead zone for the whole body. Every
   call threw a ReferenceError, an empty catch swallowed it, and the stored
   rides showed 0 strokes refined with no error recorded. No unit test could see
   it, because the throw was inside a function nothing but a real rider reaches.

   So this suite reads the source: inside every long function, no local
   declaration may reuse the name of a module-level function that the same body
   calls — and no failure of the refine pass may go unrecorded. */
import { browser, BASE, T, finish } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage();
await page.goto(`${BASE}/index.html`);

const r = await page.evaluate(async () => {
  const src = await (await fetch('/js/analysis.js')).text();
  const A = await import('/js/analysis.js');
  const C = await import('/js/config.js');

  // module-level function names
  const top = [...src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)].map((m) => m[1]);
  /* Each top-level function body, by brace matching. The parameter list is
     skipped by matching its own parentheses first — analyzeSideClip has
     `opts = {}` in its signature, and a scanner that took the first brace as
     the body's start read an empty body and passed the very bug this guards. */
  const bodies = [];
  for (const m of src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/gm)) {
    let i = m.index + m[0].length - 1, depth = 0;
    for (; i < src.length; i++) { if (src[i] === '(') depth++; else if (src[i] === ')' && --depth === 0) break; }
    const open = src.indexOf('{', i);
    depth = 0; let j = open;
    for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}' && --depth === 0) break; }
    bodies.push({ name: m[1], body: src.slice(open, j + 1) });
  }
  const biggest = bodies.reduce((a, b) => (b.body.length > a.body.length ? b : a)).name;
  const shadows = [];
  for (const { name, body } of bodies) {
    for (const d of body.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=/g)) {
      const local = d[1];
      if (!top.includes(local) || local === name) continue;
      if (new RegExp(`\\b${local}\\(`).test(body)) shadows.push(`${name}: const ${local} shadows ${local}()`);
    }
  }

  // the offset helper on synthetic rows
  const rows = Array.from({ length: 12 }, (_, i) => ({
    kneeBend: 30 + i * 0.1, hip: 50,
    sweep: { kneeBend: 30 + i * 0.1, hip: 50, toeDown: 5, fine: { kneeBend: 31.5 + i * 0.1, hip: 49, toeDown: 5 } },
  }));
  const idxs = rows.map((_, i) => i);
  const off = A.modelOffset(rows, idxs, 'kneeBend');
  const few = A.modelOffset(rows, idxs.slice(0, 3), 'kneeBend');
  rows.forEach((r) => { r.sweep.fine.hip = 70; });
  const wild = A.modelOffset(rows, idxs, 'hip');
  const noneRead = A.modelOffset(rows.map(({ sweep, ...r }) => r), idxs, 'kneeBend');

  return {
    shadows, functions: bodies.length, biggest,
    off, few, wild, noneRead, cfg: C.FINE_OFFSET,
    refineCatchesRecord: !/catch \{ \/\* (the sweep still stands|as above|sweep stands) \*\/ \}/.test(src)
      && (src.match(/timing\.refineError = e\?\.message/g) ?? []).length >= 3,
    curveCorrected: /const kneeBDC = corrected\(curve\?\.kneeBDC, fineOffset\?\.knee\) \?\? kneePk/.test(src),
    sameFrameKept: /if \(k === 0\) same = m;/.test(src) && /rows\[i\]\.sweep = \{ kneeBend: rows\[i\]\.kneeBend/.test(src),
    offsetTravels: /fineOffset,\s*\n/.test(src) && /curveDiag: curve \? null : curveDiag/.test(src),
    footnoteShowsError: /r\.refined\.refineError/.test(await (await fetch('/js/pages/analyze.js')).text()),
    noSubframeWithCurve: /const fineSteps = curve \? 0 : SUBFRAME\.steps/.test(src),
  };
});

T('no local declaration shadows a module-level function its body calls', r.shadows.length === 0,
  r.shadows.join('; ') || `${r.functions} function bodies checked`);
T('and the scan actually reaches the analysis body', r.biggest === 'analyzeSideClip',
  `largest body found: ${r.biggest}`);
T('the refine pass records what went wrong instead of swallowing it', r.refineCatchesRecord);
T('the accurate model reads the same frame as the sweep and keeps both', r.sameFrameKept);
T('the median same-frame difference is the model offset', r.off && Math.abs(r.off.value - 1.5) < 0.01 && r.off.n === 12,
  JSON.stringify(r.off));
T('a handful of strokes is not evidence of a bias', r.few === null, `min ${r.cfg.minStrokes} strokes`);
T('a gap of many degrees is a misread frame, not a calibration', r.wild === null, `beyond ${r.cfg.maxDeg}°`);
T('no re-read frames means no correction', r.noneRead === null);
T('the curve is shifted by that offset, and falls back to one-frame reads without one', r.curveCorrected);
T('with a curve there is no sub-frame search — the comparison is frame for frame', r.noSubframeWithCurve);
T('the offset and the reason for a missing curve travel with the report', r.offsetTravels);
T('the footnote shows a refine failure to the rider, not just a model download one', r.footnoteShowsError);
await b.close();
finish();
