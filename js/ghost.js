/* THE GREEN FIGURE — where the numbers would put this rider.
 *
 * A report that says "saddle 8 mm down" has told the rider a fact and left
 * them to imagine it. Golf coaching apps draw the corrected swing as a
 * translucent figure over the golfer's own video, and that picture does what
 * the sentence cannot: it shows the change in the rider's own body, on their
 * own bike, at the size it actually is.
 *
 * Nothing here is invented. The figure is the rider's own joints, moved by
 * exactly the change the measurement asks for, with the bones kept at the
 * lengths this frame shows them at:
 *
 *   side  — the saddle moves, so the hip moves along the line from the pedal
 *           up through the hip, and the knee is re-solved as the meeting of a
 *           thigh-length circle about the new hip and a shin-length circle
 *           about the ankle. The foot stays on the pedal, which does not move.
 *   front — a knee that tracks straight sits on the plumb line above its
 *           ankle, so the figure's knee is moved onto that line.
 *   rear  — level shoulders and hips.
 *
 * All geometry is done in SQUARED coordinates (x scaled by the aspect ratio,
 * so a unit is a unit in both directions) and handed back in the frame's own
 * normalised coordinates, which is what everything draws in. */
import { solveKnee } from "./limbs.js";

export const GHOST = {
  insideBy: 3,      // degrees inside the nearest band edge the figure aims for
};

const sq = (p, ar) => (p ? { x: p.x * ar, y: p.y } : null);
const un = (p, ar) => (p ? { x: p.x / ar, y: p.y } : null);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/* The angle the figure should show. Only a read outside the range asks for a
   move; a rider inside it, or too close to the edge to call, is not sent
   anywhere — the figure then sits on top of them, which is the answer. */
export function targetBend(value, verdict, [lo, hi], insideBy = GHOST.insideBy) {
  if (!Number.isFinite(value)) return null;
  if (verdict === "low") return lo + insideBy;
  if (verdict === "high") return hi - insideBy;
  return null;
}

/* Knee bend as drawn flat on the picture: 180 minus the included angle. */
export function flatBend(hip, knee, ankle) {
  const a = Math.atan2(hip.y - knee.y, hip.x - knee.x) - Math.atan2(ankle.y - knee.y, ankle.x - knee.x);
  let deg = Math.abs(a) * 180 / Math.PI;
  if (deg > 180) deg = 360 - deg;
  return 180 - deg;
}

/* How far the hip has to move, in the bottom-of-stroke frame, for the knee to
   bend `delta` degrees more (positive) or less (negative) than it does now.
   Returns the shift in frame coordinates, its length in frame-height units
   (for millimetres), and the flat bend the figure will show in this frame. */
export function saddleShift(j, ar, delta) {
  if (!j?.hip || !j?.knee || !j?.ankle || !Number.isFinite(delta)) return null;
  const hip = sq(j.hip, ar), knee = sq(j.knee, ar), ankle = sq(j.ankle, ar);
  const f = dist(hip, knee), t = dist(knee, ankle), d = dist(hip, ankle);
  if (!(f > 1e-4) || !(t > 1e-4) || !(d > 1e-4)) return null;
  const now = flatBend(hip, knee, ankle);
  const want = Math.min(175, Math.max(2, now + delta));
  const inc = (180 - want) * Math.PI / 180;
  const d2 = Math.sqrt(Math.max(0, f * f + t * t - 2 * f * t * Math.cos(inc)));
  const units = d2 - d;                      // + = hip further from the pedal (saddle up)
  const ux = (hip.x - ankle.x) / d, uy = (hip.y - ankle.y) / d;
  return {
    shift: un({ x: ux * units, y: uy * units }, ar),
    units, bend: want, delta,
    direction: units > 0 ? "up" : units < 0 ? "down" : null,
  };
}

/* One frame's figure for the side view. The hip carries the shift, the foot
   stays on the pedal, the knee is re-solved with this frame's own bone
   lengths, and the upper body goes with the hip. Returns null when the frame
   has no leg to move. */
export function ghostSide(j, ar, shift) {
  if (!j?.hip || !j?.knee || !j?.ankle || !shift) return null;
  const s = sq(shift, ar);
  const hip = sq(j.hip, ar), knee = sq(j.knee, ar), ankle = sq(j.ankle, ar);
  const bones = { femur: dist(hip, knee), tibia: dist(knee, ankle) };
  const hip2 = { x: hip.x + s.x, y: hip.y + s.y };
  let knee2 = solveKnee(hip2, ankle, bones, knee);
  if (!knee2) {
    // Straighter than the leg can reach: put the knee on the line, at the thigh.
    const d = dist(hip2, ankle) || 1e-6;
    knee2 = { x: hip2.x + (ankle.x - hip2.x) * bones.femur / d, y: hip2.y + (ankle.y - hip2.y) * bones.femur / d };
  }
  const moved = (p) => (p ? un({ x: p.x * ar + s.x, y: p.y + s.y }, ar) : undefined);
  return {
    hip: un(hip2, ar), knee: un(knee2, ar), ankle: j.ankle,
    sho: moved(j.sho), elbow: moved(j.elbow), wrist: moved(j.wrist), ear: moved(j.ear),
    bend: flatBend(hip2, knee2, ankle),
  };
}

/* The front view: each knee brought onto the plumb line above its ankle. */
export function ghostFront(j) {
  if (!j) return null;
  const out = {};
  for (const s of ["l", "r"]) {
    const knee = j[`${s}knee`], ankle = j[`${s}ankle`];
    if (!knee || !ankle) continue;
    out[`${s}knee`] = { x: ankle.x, y: knee.y };
    out[`${s}ankle`] = ankle;
    if (j[`${s}hip`]) out[`${s}hip`] = j[`${s}hip`];
  }
  return Object.keys(out).length ? out : null;
}

/* The rear view: shoulders and hips level, each about its own midpoint. */
export function ghostRear(j) {
  if (!j) return null;
  const out = {};
  for (const [l, r] of [["lsho", "rsho"], ["lhip", "rhip"]]) {
    if (!j[l] || !j[r]) continue;
    const mid = (j[l].y + j[r].y) / 2;
    out[l] = { x: j[l].x, y: mid };
    out[r] = { x: j[r].x, y: mid };
  }
  return Object.keys(out).length ? out : null;
}
