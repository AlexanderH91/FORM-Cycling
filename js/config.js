// Shared FORM backend (same Supabase project as FORM Golf and FORM Cycling —
// one login across every FORM app).
export const SUPABASE_URL = "https://nrmpntocdashxlzdqmcp.supabase.co";
export const SUPABASE_KEY = "sb_publishable_kS46cZQwLOJg6IvNWagNXA_faBH5ffq";

// Running data is its own table; Golf and Cycling keep theirs.
export const SESSION_TABLE = "running_sessions";

/* Evidence-based coaching bands.

   Rule 4 of the FORM honesty rules: every band cites research, and nothing is
   banded that the literature does not actually support in the units we measure
   it in. Running has far fewer defensible bands than bike fit does, so most of
   what this app measures is reported WITHOUT a verdict. That is deliberate.
   An unbanded number that tracks over time is honest; an invented threshold is
   not, however coach-like it sounds. */
export const BANDS = {
  /* Step rate, both feet. Heiderscheit et al. 2011 (Med Sci Sports Exerc) found
     raising step rate 5–10% cut load at the hip and knee; Schubert, Kempf &
     Heiderscheit 2014 (Sports Health) reviews the same effect. Both are about
     a runner's change from their OWN baseline. The 170–180 window is the range
     those studies work in, not a universal target — cadence rises with speed
     and falls with stature, so a tall runner at 168 is not doing it wrong.
     Below the window we coach; above it we report and say nothing. */
  cadenceSpm: [170, 180],

  /* Forward trunk lean from vertical, at the trunk's average over the clip.
     Teng & Powers 2014 (J Orthop Sports Phys Ther) found ~10° of forward trunk
     lean lowered patellofemoral joint stress against an upright trunk. The band
     is the working window around that finding. Lean is measured from the hip to
     the shoulder, so it is lean of the whole trunk, not a bend at the waist. */
  trunkLean: [8, 14],
};

/* Measured and reported, but never given a verdict word, because no cited band
   exists for them in the units FORM can measure from one phone camera. They are
   here so the report can say WHY a number carries no judgement, rather than
   leaving the reader to wonder. */
export const NO_BAND_REASON = {
  kneeAtContact: "Knee flexion at contact varies with speed and footwear, and FORM has no cited band for it yet — so it is reported, not judged.",
  shankAtContact: "How far your shin leans past vertical when you land is the overstriding signal, but the research is stated in units a phone can't reproduce. Reported without a verdict.",
  verticalOscillation: "Measured against your own leg length, so it needs no calibration — and has no research band in those units. Useful as a number to watch across runs.",
  kneeSway: "Side-to-side knee travel has no cited band in FORM. Left-versus-right evenness IS judged, because it compares you with yourself.",
  pelvicTilt: "FORM measures the TOTAL side-to-side range of your pelvis. Published thresholds describe peak drop on one leg, which is a different quantity — so this number travels without a verdict rather than borrowing a band that doesn't fit it.",
};

/* Capture quality. These are checks on the FOOTAGE, not claims about the
   runner, so they are heuristics rather than research bands — tune them against
   real clips. Two are reliable enough to refuse a read outright (the model
   either saw you or it didn't); squareness and framing only downgrade the
   report to provisional, because they are inferred rather than measured. */
export const CAPTURE = {
  minDetection: 0.5,      // share of sampled frames with a pose at all
  minVisibility: 0.4,     // mean confidence of the joints we measure
  offSquareWarnDeg: 8,    // below this the side view is square enough to trust
  offSquareMaxDeg: 15,    // rule 3's own number: past this, no degree verdicts
  maxClipped: 0.25,       // share of frames with a measured joint at the edge
  minJointVisibility: 0.4,// per-frame confidence floor for a joint we measure
  /* Inherited from FORM Cycling, and still off for the same reason: the
     estimate read 21° on footage with 99% detection and 92% visibility, which
     is a well-shot clip. It reports so it can be checked against real running
     clips; it does not yet suppress a read. */
  squarenessGates: false,
  // Trunk proportion used to turn hip separation into an angle. Population
  // average, not this runner — which is why it grades rather than measures.
  hipWidthOverTrunk: 0.55,
};

/* Sampling. Running is faster than pedalling: a foot is on the ground for
   roughly a fifth of a second, so 15 fps (FORM Cycling's rate) can miss the
   contact frame entirely. 20 fps costs more seeks but lands nearer the strike.
   The window is shorter to keep the total number of seeks about the same —
   forty seconds of steady running is a lot of strides. */
export const ANALYSIS = {
  fps: 20,
  maxSeconds: 40,
  minStrides: 5,
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
