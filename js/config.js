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
