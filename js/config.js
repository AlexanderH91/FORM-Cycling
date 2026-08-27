/* Bump on every deploy, and bump the copy in index.html to match.
   There are deliberately two of them. This one ships inside a module, so it is
   whatever the browser last cached; the one in index.html arrives with the
   page, which revalidates far more aggressively. The version badge shows both,
   so stale JavaScript announces itself instead of being mistaken for a bug —
   "is this the new code?" has cost more debugging rounds here than any bug. */
export const VERSION = "v2";
export const BUILD = "2026-08-27-j";

// Shared FORM backend (same Supabase project as FORM Golf — one login everywhere).
export const SUPABASE_URL = "https://nrmpntocdashxlzdqmcp.supabase.co";
export const SUPABASE_KEY = "sb_publishable_kS46cZQwLOJg6IvNWagNXA_faBH5ffq";

// Evidence-based coaching bands (see bands source list in README).
export const BANDS = {
  kneeBendBDC: [30, 40],        // dynamic, degrees of flexion at 6 o'clock
  hipTDC: [44, 58],
  ankle: [75, 105],
  footToeDown6: [5, 20],
  cadence: [75, 95],
};

/* Capture quality. These are checks on the FOOTAGE, not claims about the rider,
   so they are heuristics rather than research bands — tune them against real
   clips. Two are reliable enough to refuse a read outright (the model either
   saw you or it didn't); squareness and framing only downgrade the report to
   provisional, because they are inferred rather than measured directly. */
export const CAPTURE = {
  minDetection: 0.5,      // share of sampled frames with a pose at all
  minVisibility: 0.4,     // mean confidence of the joints we measure
  offSquareWarnDeg: 8,    // below this the side view is square enough to trust
  offSquareMaxDeg: 15,    // rule 3's own number: past this, no degree verdicts
  maxClipped: 0.25,       // share of frames with a measured joint at the edge
  minJointVisibility: 0.4,// per-frame confidence floor for a joint we measure
  /* The off-square estimate reports but does not yet suppress a read. It
     called a clip with 99% detection and 92% visibility 21° off square, which
     is almost certainly the estimator's floor rather than the camera. Turn
     this on once the figure has been checked against clips known to be square
     and known to be angled. */
  squarenessGates: false,
  // Trunk proportion used to turn hip separation into an angle. Population
  // average, not this rider — which is why it grades rather than measures.
  hipWidthOverTrunk: 0.55,
};

/* How far a reading can be off for reasons that averaging more pedal strokes
   will never fix: where the phone was stood, lens distortion, and the pose
   model's own bias on a joint. It is an ASSUMPTION, not something measured
   from your clip — declared here so the number every verdict rests on is
   visible instead of buried. Once you have three rides FORM stops assuming it
   and uses the scatter between those rides instead, which measures the same
   thing for real. */
export const ANGLE_FLOOR_DEG = 2.0;

/* How far the band edge must sit from your reading, in units of that
   uncertainty, before FORM will call a side. 1.5 is roughly 93% confidence on
   a one-sided call — enough to move a saddle 5 mm on, not enough to claim
   certainty. */
export const VERDICT_SIGMAS = 1.5;

/* Rides needed before the scatter between them is worth more than the
   assumption above. Below this, a close call stays a close call. */
export const SETTLE_RIDES = 3;

export const MAX_RECORD_MS = 10 * 60 * 1000; // 10 minutes

// Length of the emailed sign-in code. Must match Supabase → Auth → Providers →
// Email → "Email OTP Length" (Supabase allows 6–10). The login screen uses this
// for its copy and for auto-submitting once the code is complete; a code of any
// length from 6 up can still be submitted by hand, and the server is the judge.
export const OTP_LENGTH = 8;

// Voice coach. The OpenAI key never lives here — this endpoint is an Edge
// Function that holds it and returns a client secret good for about a minute.
// Set it there once:  supabase secrets set OPENAI_API_KEY=sk-...
export const COACH_TOKEN_ENDPOINT = `${SUPABASE_URL}/functions/v1/coach-token`;
