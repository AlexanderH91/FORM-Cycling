/* The green figure: where the numbers would put this rider, drawn on their
   own video. Nothing invented — the rider's own joints, moved by exactly the
   change the read asks for, bones kept at the lengths this frame shows. */
import { browser, BASE, T, finish } from './lib.mjs';
const chromium = await browser();
const b = await chromium.launch();
const page = await b.newPage();
await page.goto(`${BASE}/index.html`);

const r = await page.evaluate(async () => {
  const G = await import('/js/ghost.js');
  const C = await import('/js/config.js');
  const band = C.BANDS.kneeBendBDC;
  const ar = 1080 / 1920;
  // A leg at the bottom of the stroke, in frame coordinates of a portrait clip.
  const j = { hip: { x: 0.50, y: 0.40 }, knee: { x: 0.62, y: 0.60 }, ankle: { x: 0.52, y: 0.80 },
              sho: { x: 0.80, y: 0.25 }, elbow: { x: 0.95, y: 0.35 }, ear: { x: 0.92, y: 0.15 } };
  const sq = (p) => ({ x: p.x * ar, y: p.y });
  const dist = (a, c) => Math.hypot(a.x - c.x, a.y - c.y);
  const now = G.flatBend(sq(j.hip), sq(j.knee), sq(j.ankle));

  const down = G.saddleShift(j, ar, +8);          // bend 8° more: saddle comes down
  const up = G.saddleShift(j, ar, -6);            // bend 6° less: saddle goes up
  const gDown = G.ghostSide(j, ar, down.shift);
  const gUp = G.ghostSide(j, ar, up.shift);
  const same = G.ghostSide(j, ar, { x: 0, y: 0 });
  const bones = (g) => ({ femur: dist(sq(g.hip), sq(g.knee)), tibia: dist(sq(g.knee), sq(g.ankle)) });
  const own = bones(j);

  return {
    now, band,
    target: { low: G.targetBend(24.7, 'low', band), high: G.targetBend(44, 'high', band),
              ok: G.targetBend(35, 'ok', band), border: G.targetBend(30.5, 'borderline', band) },
    down: { dir: down.direction, units: down.units, bend: gDown.bend, ankle: gDown.ankle, bones: bones(gDown), hipY: gDown.hip.y },
    up: { dir: up.direction, units: up.units, bend: gUp.bend, bones: bones(gUp), hipY: gUp.hip.y },
    own, hipY: j.hip.y,
    sameIsRider: Math.abs(same.hip.x - j.hip.x) < 1e-9 && Math.abs(same.knee.x - j.knee.x) < 1e-9 && Math.abs(same.knee.y - j.knee.y) < 1e-9,
    upperMoves: Math.abs((gDown.sho.y - j.sho.y) - (gDown.hip.y - j.hip.y)) < 1e-9 && gDown.ear && gDown.elbow,
    sideKept: Math.sign(gDown.knee.x - gDown.hip.x) === Math.sign(j.knee.x - j.hip.x),
    front: G.ghostFront({ lknee: { x: 0.40, y: 0.6 }, lankle: { x: 0.45, y: 0.8 }, lhip: { x: 0.42, y: 0.4 } }),
    rear: G.ghostRear({ lhip: { x: 0.4, y: 0.62 }, rhip: { x: 0.6, y: 0.58 } }),
    noLeg: G.ghostSide({ hip: { x: 0.5, y: 0.4 } }, ar, { x: 0, y: 0 }),
  };
});

T('a read below the range aims just inside its lower edge, above it just inside the upper',
  r.target.low === r.band[0] + 3 && r.target.high === r.band[1] - 3, `${r.target.low}° and ${r.target.high}°`);
T('inside the range, or too close to call, the figure is sent nowhere', r.target.ok === null && r.target.border === null);
T('more bend means the saddle comes down: the hip moves towards the pedal',
  r.down.dir === 'down' && r.down.units < 0 && r.down.hipY > r.hipY);
T('less bend means the saddle goes up', r.up.dir === 'up' && r.up.units > 0 && r.up.hipY < r.hipY);
T('the figure shows exactly the bend that was asked for',
  Math.abs(r.down.bend - (r.now + 8)) < 0.2 && Math.abs(r.up.bend - (r.now - 6)) < 0.2,
  `${r.now.toFixed(1)}° now; figure ${r.down.bend.toFixed(1)}° and ${r.up.bend.toFixed(1)}°`);
T('with the same thigh and shin as the rider, and the foot still on the pedal',
  Math.abs(r.down.bones.femur - r.own.femur) < 1e-6 && Math.abs(r.down.bones.tibia - r.own.tibia) < 1e-6
  && Math.abs(r.up.bones.femur - r.own.femur) < 1e-6 && r.down.ankle.y === 0.80);
T('the knee stays on the rider\'s side of the leg, never mirrored', r.sideKept);
T('the upper body moves with the hip', !!r.upperMoves);
T('a shift of nothing is the rider exactly', r.sameIsRider);
T('from the front, each knee is brought onto the plumb line above its foot',
  r.front && r.front.lknee.x === 0.45 && r.front.lknee.y === 0.6 && r.front.lhip.x === 0.42);
T('from behind, the hips are made level about their midpoint',
  r.rear && r.rear.lhip.y === 0.6 && r.rear.rhip.y === 0.6);
T('a frame with no leg draws no figure', r.noLeg === null);

// Wiring: the figure reaches the still, the player and the report.
const w = await page.evaluate(async () => {
  const src = await (await fetch('/js/analysis.js')).text();
  const pg = await (await fetch('/js/pages/analyze.js')).text();
  return {
    reportCarriesIt: /^\s+ghost,$/m.test(src) && /target: ghostTarget, from: \+kneeBDC\.value\.toFixed\(1\)/.test(src),
    followsThePooledRead: /targetBend\(pooled\.value, pooledVerdict, BANDS\.kneeBendBDC\)/.test(src),
    stillDrawsItUnderTheRider: src.indexOf('figure(ctx, body.length >= 3 ? body') < src.indexOf('limb(ctx, [j.hip, j.knee, j.ankle], kneeColour, w, h)'),
    stillSaysWhatItIs: /The green figure is you with the saddle/.test(src),
    inMillimetres: /mm: mm != null \? Math\.round\(mm\) : null/.test(src) && /ruler: !shift \? null : scale \? "wheel"/.test(src),
    playerGhostUnderLines: pg.indexOf('spec().drawGhost(ctx, f, at, lw, r') < pg.indexOf('spec().draw(ctx, f, at, lw)'),
    everyViewHasOne: (pg.match(/drawGhost\(ctx, f, at, lw/g) ?? []).length >= 3,
    toggle: /id="mvghost"/.test(pg) && /showGhost = !showGhost/.test(pg),
    savedFrameKeepsIt: /if \(showGhost && spec\(\)\.ghost\?\.\(r\)\) spec\(\)\.drawGhost\(g, f, at, lw, r/.test(pg),
    ridersSeeNoJargon: !/ghost/i.test(pg.match(/ghostLabel: \(r\) =>[\s\S]*?"\),/)?.[0]?.replace(/ghostLabel|r\.ghost|ghost\.side/g, '') ?? ''),
  };
});
T('the report carries the figure, computed from the pooled read like the fix card', w.reportCarriesIt && w.followsThePooledRead);
T('the knee still draws it under the rider\'s own lines and says what it is', w.stillDrawsItUnderTheRider && w.stillSaysWhatItIs);
T('the change is given in millimetres, scaled by the wheel where there is one', w.inMillimetres);
T('the player draws it beneath the lines in every view, with a toggle, and keeps it in a saved frame',
  w.playerGhostUnderLines && w.everyViewHasOne && w.toggle && w.savedFrameKeepsIt);
T('the rider is told "the green figure", never "ghost"', w.ridersSeeNoJargon);
await b.close();
finish();
