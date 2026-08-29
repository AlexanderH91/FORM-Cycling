/* A body is a linkage, not a cloud of independent dots.
 *
 * The pose model treats every joint as its own guess, so when a handlebar
 * crosses a knee it puts the "knee" somewhere plausible-looking and moves on —
 * which is how a shin came to be drawn along a forearm. But a thigh does not
 * change length between frames, and a knee cannot be anywhere except at the
 * distance of one femur from the hip and one tibia from the ankle. Those two
 * facts turn an occluded joint from a guess into an intersection of circles
 * with at most two answers.
 *
 * None of this needs a bigger model. It needs the model's own good frames to
 * measure the rider, and then geometry to hold every other frame to it. */

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

/* This rider's own bone lengths, taken from the frames where the model clearly
   saw the whole leg. Measured per clip, because they are in frame units and
   the camera sits somewhere different for every angle. */
export function boneLengths(frames) {
  const femur = [], tibia = [];
  for (const f of frames) {
    if (!f.hip || !f.knee || !f.ankle) continue;
    femur.push(dist(f.hip, f.knee));
    tibia.push(dist(f.knee, f.ankle));
  }
  if (femur.length < 5) return null;
  return { femur: median(femur), tibia: median(tibia), from: femur.length };
}

/* Does this frame's leg match the rider we measured? A "knee" that makes the
   thigh half again as long as this person's thigh is not their knee. */
export function limbsAgree(hip, knee, ankle, bones, tol = 0.25) {
  if (!bones || !hip || !knee || !ankle) return false;
  const f = dist(hip, knee) / bones.femur;
  const t = dist(knee, ankle) / bones.tibia;
  return Math.abs(f - 1) <= tol && Math.abs(t - 1) <= tol;
}

/* Where the knee must be, given the two ends of the leg and its bone lengths.
 *
 * Two circles: one of radius femur about the hip, one of radius tibia about
 * the ankle. They meet in at most two points, mirrored about the hip-ankle
 * line, and the knee is one of them. `hint` picks which — the model's own
 * rough guess, or the last frame's knee. Even a badly placed guess almost
 * always gets the SIDE right, which is all that is being asked of it. */
export function solveKnee(hip, ankle, bones, hint) {
  if (!bones || !hip || !ankle) return null;
  const { femur: f, tibia: t } = bones;
  const d = dist(hip, ankle);
  // A leg cannot be stretched longer than its bones, nor folded inside them.
  if (d > f + t || d < Math.abs(f - t) || d < 1e-6) return null;

  const a = (f * f - t * t + d * d) / (2 * d);
  const hSq = f * f - a * a;
  if (hSq < 0) return null;
  const h = Math.sqrt(hSq);

  const ux = (ankle.x - hip.x) / d, uy = (ankle.y - hip.y) / d;
  const px = hip.x + a * ux, py = hip.y + a * uy;
  const one = { x: px - h * uy, y: py + h * ux };
  const two = { x: px + h * uy, y: py - h * ux };
  if (!hint) return one;
  return dist(one, hint) <= dist(two, hint) ? one : two;
}

/* A joint cannot teleport. At 15 fps a knee moves a few per cent of the frame
   between samples, not a third of it — so a jump that large is the model
   losing the joint rather than the rider moving. */
export function movedTooFar(previous, current, maxStep) {
  if (!previous || !current) return false;
  return dist(previous, current) > maxStep;
}

/* Take a leg the model reported and return the best version of it: as
   measured when it agrees with the rider's own proportions, reconstructed
   when the ends are trustworthy and the middle is not, and null when neither
   holds. `repaired` says which happened, so the report can be honest about
   how a number was arrived at. */
export function bestLeg({ hip, knee, ankle }, bones, hint, tol = 0.25) {
  if (!hip || !ankle) return null;
  if (limbsAgree(hip, knee, ankle, bones, tol)) return { hip, knee, ankle, repaired: false };
  const solved = solveKnee(hip, ankle, bones, hint ?? knee);
  return solved ? { hip, knee: solved, ankle, repaired: true } : null;
}
