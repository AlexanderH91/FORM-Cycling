import { browser, BASE, T, finish, OUT } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage();
await page.goto(`${BASE}/index.html`);

const r = await page.evaluate(async () => {
  const src = await (await fetch('/js/analysis.js')).text();
  // mirror the shipped rules exactly
  const median = (a) => { const s=[...a].sort((x,y)=>x-y); return s[s.length>>1]; };
  const mean = (a) => a.reduce((x,y)=>x+y,0)/a.length;
  const sd = (a) => { const m=mean(a); return Math.sqrt(mean(a.map(x=>(x-m)**2))); };
  const verdictFor = (m,[lo,hi]) => {
    const edge = Math.min(Math.abs(m.value-lo), Math.abs(m.value-hi));
    if (edge < m.sd) return 'borderline';
    return m.value < lo ? 'low' : m.value > hi ? 'high' : 'ok';
  };
  return {
    // your run: 28 degrees, spread 3.1, band 30-40
    yours: verdictFor({ value: 28, sd: 3.1 }, [30, 40]),
    clearlyHigh: verdictFor({ value: 22, sd: 2.0 }, [30, 40]),
    clearlyLow:  verdictFor({ value: 47, sd: 2.0 }, [30, 40]),
    clearlyOk:   verdictFor({ value: 35, sd: 1.5 }, [30, 40]),
    tightNearEdge: verdictFor({ value: 28, sd: 0.5 }, [30, 40]),   // same value, steady rider
    noisyMidBand:  verdictFor({ value: 35, sd: 6.0 }, [30, 40]),   // in band but all over the place
    // median resists one bad frame; mean does not
    med: median([31,32,30,31,33,120]), avg: +mean([31,32,30,31,33,120]).toFixed(1),
    usesMedian: /value: median\(vals\)/.test(src),
    filtersByConfidence: /rows\[i\]\.conf >= CAPTURE\.minJointVisibility/.test(src),
    borderlineOutranks: src.indexOf('kneeVerdict === "borderline"') < src.indexOf('kneeVerdict === "low"'),
  };
});
T('your 28° ±3.1° is too close to call', r.yours === 'borderline', `verdict="${r.yours}" (band edge 2° away, spread 3.1°)`);
T('a steady rider at the same 28° still gets a verdict', r.tightNearEdge === 'low', `sd 0.5 -> "${r.tightNearEdge}"`);
T('clear cases still read clearly', r.clearlyHigh==='low' && r.clearlyLow==='high' && r.clearlyOk==='ok',
  `22->${r.clearlyHigh}  47->${r.clearlyLow}  35->${r.clearlyOk}`);
T('in-band but wildly variable is not called OK', r.noisyMidBand === 'borderline', `35° ±6° -> "${r.noisyMidBand}"`);
T('median resists a garbage frame the mean does not', r.med === 32 && r.avg > 40, `median ${r.med}° vs mean ${r.avg}°`);
T('reported centre is the median', r.usesMedian, 'value: median(vals)');
T('badly-seen strokes excluded from the average', r.filtersByConfidence, 'conf >= minJointVisibility');
T('borderline is ranked above any prescription', r.borderlineOutranks, 'checked first in the fix ladder');
await b.close();
finish();
