import { browser, BASE, T, finish, OUT } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage();
await page.goto(`${BASE}/index.html`);
const out = await page.evaluate(async () => {
  const { angleAt, squareUp } = await import('/js/analysis.js');
  const W = 1280, H = 720, ar = W / H;
  const sq = squareUp(ar);
  const norm = (p) => ({ x: p[0] / W, y: p[1] / H });
  // ground truth in pixel space — the units the rider actually exists in
  const truth = (a, b, c) => angleAt({x:a[0],y:a[1]}, {x:b[0],y:b[1]}, {x:c[0],y:c[1]});
  const fixed = (a, b, c) => angleAt(sq(norm(a)), sq(norm(b)), sq(norm(c)));
  const naive = (a, b, c) => angleAt(norm(a), norm(b), norm(c));
  const cases = [
    ['BDC a', [640,300],[700,450],[690,600]],
    ['BDC b', [620,300],[720,460],[700,610]],
    ['TDC a', [560,180],[640,300],[730,360]],
    ['TDC b', [540,170],[640,300],[750,340]],
    ['square-ish', [500,200],[600,400],[520,600]],
  ];
  return cases.map(([n,a,b,c]) => ({ n, truth: truth(a,b,c), fixed: fixed(a,b,c), naive: naive(a,b,c) }));
});
let bad = 0;
console.log('case'.padEnd(12) + 'true'.padStart(8) + 'fixed'.padStart(9) + 'err'.padStart(7) + '   ' + 'was(naive)'.padStart(12) + 'err'.padStart(8));
for (const r of out) {
  const ef = Math.abs(r.fixed - r.truth), en = Math.abs(r.naive - r.truth);
  if (ef > 0.01) bad++;
  console.log(`${r.n.padEnd(12)}${r.truth.toFixed(1).padStart(8)}${r.fixed.toFixed(1).padStart(9)}${ef.toFixed(2).padStart(7)}   ${r.naive.toFixed(1).padStart(12)}${en.toFixed(1).padStart(8)}`);
}
console.log(bad === 0
  ? '\nPASS — corrected angles match pixel-space truth to <0.01°'
  : `\nFAIL — ${bad} case(s) still off`);
await b.close();
finish();
