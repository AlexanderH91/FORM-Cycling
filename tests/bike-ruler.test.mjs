/* The bike as the ruler: the front wheel read during the side pass, its 670 mm
   turned into millimetres per frame-unit, and that scale checked against the
   crank the foot drew. Two rulers that have never met have to agree on how
   long a 172.5 mm crank looks, or neither is trusted for centimetres. */
import { browser, BASE, T, finish } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage();
await page.goto(`${BASE}/index.html`);

const wired = await page.evaluate(async () => {
  const src = await (await fetch('/js/analysis.js')).text();
  const pg = await (await fetch('/js/pages/analyze.js')).text();
  const block = src.slice(src.indexOf('THE BIKE AS THE RULER'), src.indexOf('onProgress(95, "Pulling the frame'));
  return {
    readsSeveralFrames: /for \(const f of \[0\.2, 0\.4, 0\.6, 0\.8\]\)/.test(block),
    downscaled: /const W = 320/.test(block),
    skipsBlankFrames: /if \(!hasPicture\(g, W, H\)\) continue;/.test(block),
    settlesAcrossFrames: /settleWheel\(grabs\)/.test(block),
    scaleInFrameUnits: /const mmPerUnit = cal\.mmPerPx \* H;/.test(block),
    crossChecksTheCrank: /crankMm = curve\?\.spindle \? \+\(curve\.spindle\.r \* mmPerUnit\)/.test(block)
      && /rulersAgree: crankMm != null && crankMm >= 155 && crankMm <= 185/.test(block),
    yawReplacesTheGuess: /capture\.offSquareDeg = wheel\.yawDeg;/.test(src) && /squarenessFrom = "wheel"/.test(src),
    travelsWithTheReport: /^    wheel, scale,$/m.test(src),
    toldToTheRider: /your crank measures \$\{r\.scale\.crankMm\} mm/.test(pg)
      && /Your front wheel, measured separately, agrees with it\./.test(src),
    disagreementIsSaid: /which is not a crank, so one of the two rulers is off/.test(pg),
    neverBlocks: /catch \{ \/\* a report without a wheel still reports \*\/ \}/.test(block),
  };
});

T('the wheel is read off several frames of the clip, downscaled, blank ones skipped',
  wired.readsSeveralFrames && wired.downscaled && wired.skipsBlankFrames && wired.settlesAcrossFrames);
T('its 670 mm becomes a scale in the units every measurement already uses', wired.scaleInFrameUnits);
T('and that scale is checked against the crank the foot drew',
  wired.crossChecksTheCrank, 'a crank outside 155–185 mm means a ruler is wrong');
T('the wheel\'s yaw replaces the hip-separation guess at how square the camera was', wired.yawReplacesTheGuess);
T('wheel and scale travel with the report', wired.travelsWithTheReport);
T('and the rider is told what the two rulers say, including when they disagree',
  wired.toldToTheRider && wired.disagreementIsSaid);
T('a clip with no findable wheel still reports everything else', wired.neverBlocks);

await b.close();
finish();
