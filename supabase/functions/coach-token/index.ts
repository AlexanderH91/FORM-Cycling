/* Mints a short-lived OpenAI Realtime client secret for the FORM voice coach.
 *
 * Why this exists: the app is a static site on GitHub Pages. An OpenAI key
 * cannot live in it — js/config.js is public and served to every visitor. So
 * the key lives here, in Edge Function secrets, and the browser only ever
 * receives an ephemeral secret that expires in about a minute.
 *
 * Requires a signed-in FORM user. Without that check this is an open, unmetered
 * proxy to someone else's OpenAI bill.
 *
 * Set the key once, and never in the repo:
 *   supabase secrets set OPENAI_API_KEY=sk-...   (or via the dashboard)
 */

const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

// Alias rather than a dated snapshot, so this keeps working as models roll.
const MODEL = Deno.env.get("COACH_MODEL") ?? "gpt-realtime";

const VOICE = Deno.env.get("COACH_VOICE") ?? "verse";

/* The coach may choose its words. It may not choose the numbers: every figure
   it says has to have come off the rider's own video, which the client sends
   in as context. This instruction is the server-side half of that rule. */
const INSTRUCTIONS = `
You are the FORM Cycling coach. You speak to a rider about a bike-fit analysis
that was measured from their own video, on their own phone.

Hard rules, in order of importance:
1. Never state a number that was not given to you in the session context. Never
   estimate, round differently, or infer a measurement. If asked something the
   analysis did not measure, say plainly that FORM did not measure it.
2. One fix at a time. The report names a single fix; that is the one you coach.
   Other findings are context you can discuss if asked, not new prescriptions.
3. Never claim a verdict for a measurement that came without one. Some numbers
   are reported with no band because no cited research band exists yet — say so
   rather than inventing "good" or "bad".
4. If the analysis was gated, the gate is the whole story. Talk about
   re-filming, not about position.

Be brief and plain. Short sentences. Talk like a coach beside the bike, not a
report being read aloud. No praise sandwiches.
`.trim();

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const fail = (status: number, error: string, detail?: unknown) =>
  new Response(JSON.stringify({ error, detail }), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return fail(405, "POST only");
  if (!OPENAI_KEY) return fail(503, "OPENAI_API_KEY is not set on this function");

  // Only signed-in FORM riders. The browser sends its Supabase access token.
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return fail(401, "Sign in to use the coach");
  const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: auth, apikey: SUPABASE_ANON_KEY ?? "" },
  });
  if (!who.ok) return fail(401, "Sign in to use the coach");

  // The rider's measured report, passed through as context the model may quote.
  let context = "";
  try {
    const body = await req.json();
    if (body && typeof body.report === "object" && body.report !== null) {
      context = "\n\nThis rider's latest measured report, the only source of "
        + "numbers you may use:\n" + JSON.stringify(body.report).slice(0, 6000);
    }
  } catch { /* context is optional; a coach with none simply has less to say */ }

  const upstream = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model: MODEL,
        audio: { output: { voice: VOICE } },
        instructions: INSTRUCTIONS + context,
      },
    }),
  });

  const text = await upstream.text();
  if (!upstream.ok) {
    // Surface OpenAI's own words — a silent failure here is undiagnosable
    // from a phone, and the shape of this API has moved before.
    return fail(502, "OpenAI refused to mint a client secret", text.slice(0, 900));
  }

  let data: Record<string, unknown>;
  try { data = JSON.parse(text); } catch { return fail(502, "Unreadable response from OpenAI", text.slice(0, 300)); }

  // Read the secret defensively: this field moved between API versions.
  const secret =
    (data as any).value ??
    (data as any).client_secret?.value ??
    (data as any).client_secret;

  if (typeof secret !== "string") {
    return fail(502, "No client secret in OpenAI's response", Object.keys(data));
  }

  return new Response(JSON.stringify({ secret, model: MODEL, expires_at: (data as any).expires_at ?? null }), {
    headers: { ...cors, "Content-Type": "application/json" },
  });
});
