/* Bump on every deploy, and bump the copy in index.html to match.
   There are deliberately two of them. This one ships inside a module, so it is
   whatever the browser last cached; the one in index.html arrives with the
   page, which revalidates far more aggressively. The version badge shows both,
   so stale JavaScript announces itself instead of being mistaken for a bug —
   "is this the new code?" has cost more debugging rounds here than any bug. */
export const VERSION = "v38";
export const BUILD = "2026-09-04-v38";

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

/* Turning pixels into centimetres needs one known length. The thigh is the
   best candidate on a seated rider: it is long, it is squarely side-on, and
   both ends are joints the model locates well. The ratio is a population
   average from the standard anthropometric segment tables (Drillis & Contini),
   NOT this rider — so any centimetre figure derived from it is approximate,
   and is labelled that way wherever it is shown. */
export const FEMUR_OVER_HEIGHT = 0.245;

/* Where the pedal axle sits along the foot, as a fraction from the toe back
   towards the heel. Cleats are normally set with the axle under the ball of
   the foot, which lands about here. The model gives toe and heel; it does not
   see the pedal. */
export const AXLE_ALONG_FOOT = 0.28;

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

/* Two pose models, because they are wanted for opposite reasons.

   The sweep runs over every sampled frame (hundreds), so it has to be small
   and fast; it only needs to be good enough to find where the strokes are.
   The fine model then re-reads the handful of frames the reported number is
   actually computed from, where accuracy is the only thing that matters.

   The fine model is `heavy`: the most accurate of the three, and 30 MB against
   full's 9.4 MB. That download happens once — the service worker caches it —
   and it is spent on the dozen frames a reported number actually comes from,
   not on every frame of the clip. If it will not arrive, the sweep's own
   numbers stand and the report says which model produced them. */
export const POSE_MODEL = {
  sweep: "lite",
  fine: "heavy",
  /* The sweep model ships with the app. It used to be fetched from Google's
     CDN at the moment analysis started, which meant a rider in a garage on one
     bar of signal got "analysis failed" for a clip that was already on their
     phone. The fine model stays remote: it is an enhancement, it is only ever
     best-effort, and losing it costs accuracy rather than the whole read. */
  local: { lite: new URL("../assets/mp/pose_landmarker_lite.task", import.meta.url).href },
  url(name) {
    return this.local[name]
      ?? `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${name}/float16/1/pose_landmarker_${name}.task`;
  },
};

/* How many strokes to re-read with the fine model. Every stroke, in practice:
   each one that survives is another reading in the median, and the uncertainty
   on that median falls with the square root of how many there are. */
export const REFINE_STROKES = 40;

/* The sweep samples at 15 fps, so the bottom of a pedal stroke can fall up to
   33 ms either side of the frame that looked lowest. At 85 rpm the leg covers
   real distance in 33 ms, and the knee angle we report is taken at whichever
   frame we happened to land on — a sampling error, not a model error, and one
   no better model would fix.

   So around each stroke found by the sweep, the fine model looks again at
   three times the resolution and keeps the frame where the ankle is genuinely
   at its extreme. Five reads per stroke instead of one; the payoff is that the
   bottom of the stroke is the actual bottom. */
export const SUBFRAME = { steps: 2, divisor: 3 };

/* How long to wait for the fine model before giving up on it. It is 30 MB, so
   this has to allow for a bad connection — but not indefinitely, because an
   analysis that hangs is worse than one that is slightly less precise. */
export const FINE_MODEL_TIMEOUT_MS = 45_000;

/* Ceilings past which a figure is not a rider, it is a broken read.
   A knee does not swing 70 degrees out of vertical and a pelvis does not tilt
   127 — both of which this app printed on a card, with a straight face,
   because nothing checked. These are not coaching bands and no verdict is
   given against them: they are the line past which FORM says it could not
   measure rather than reporting a number it cannot possibly mean. */
export const SANITY = {
  kneeTravelDeg: 30,     // side-to-side knee travel across a whole stroke
  rockDeg: 25,           // shoulder or pelvis tilt from level, across a stroke

  /* The same discipline one frame at a time. An angle between two points the
     model has placed almost on top of each other is not a large angle, it is
     an undefined one — and atan2 returns something near 90 degrees for it
     rather than nothing. That is where "82 degrees off level" came from: two
     hip markers with no horizontal separation between them.

     A frame implying more than these is a frame the model got wrong, so it is
     dropped before it reaches an average or a still. */
  kneeLeanDeg: 35,       // one frame: knee out of vertical

  /* Between two adjacent samples a knee travels a fraction of a thigh. A jump
     of a whole thigh is not the rider moving — it is the model handing the
     linkage a hip or an ankle that was not theirs, and a knee rebuilt from
     those lands nowhere near the leg. Measured in femurs so it scales with
     however far away the phone was. */
  kneeStepOverFemur: 1.0,
  tiltDeg: 30,           // one frame: shoulder or hip line off level

  /* A line also needs two points that are genuinely apart. Bent over the bars,
     a rider's own back hides their hips and the model stacks both markers on
     the spine — close enough together that the angle between them is noise,
     even when it happens to come out small. */
  minSpanOfFrame: 0.06,  // shoulders must span at least this much of the frame
  hipOverShoulder: 0.45, // hips are never narrower than this share of shoulders
};

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

/* Connecting a training platform. The OAuth client secret lives only in Edge
   Function secrets — never here, because this file is served to every visitor.
   Set them once with:
     supabase secrets set STRAVA_CLIENT_ID=... STRAVA_CLIENT_SECRET=... \
                          LINK_STATE_SECRET=<long random string> \
                          APP_URL=https://alexanderh91.github.io/FORM-Cycling/ */
export const STRAVA_START = `${SUPABASE_URL}/functions/v1/strava-start`;
export const STRAVA_SYNC = `${SUPABASE_URL}/functions/v1/strava-sync`;

/* Garmin's Connect Developer Program stopped accepting new applications and
   has no announced reopening date, so there is no way to obtain credentials
   and no honest way to ship a Connect Garmin button — it could only ever
   fail. Garmin riders have two working routes instead: nearly all Garmin
   devices auto-sync to Strava, and a .TCX or .GPX file exported from Garmin
   Connect can be imported directly. */
export const GARMIN_STATUS = {
  available: false,
  reason: "Garmin has paused new developer applications, so no app can connect to Garmin Connect directly right now.",
};
