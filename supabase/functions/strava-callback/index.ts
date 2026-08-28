/* Step two: Strava sends the rider's browser back here with a code.
 *
 * This runs WITHOUT a Supabase JWT — the browser is arriving from strava.com,
 * not from the app — so the only proof of who this is, is the signed state
 * from strava-start. Nothing is written until that signature verifies.
 *
 * The token exchange needs the client secret, which is why this is a server
 * function at all: a static page cannot hold one. */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { readState } from "./state.ts";

const back = (appUrl: string, params: Record<string, string>) => {
  const q = new URLSearchParams(params).toString();
  return new Response(null, { status: 302, headers: { Location: `${appUrl}#/profile?${q}` } });
};

Deno.serve(async (req) => {
  const appUrl = Deno.env.get("APP_URL") ?? "https://alexanderh91.github.io/FORM-Cycling/";
  const url = new URL(req.url);

  // The rider pressed "Cancel" on Strava's screen. Not an error.
  if (url.searchParams.get("error")) return back(appUrl, { strava: "cancelled" });

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? "";
  const stateSecret = Deno.env.get("LINK_STATE_SECRET");
  const clientId = Deno.env.get("STRAVA_CLIENT_ID");
  const clientSecret = Deno.env.get("STRAVA_CLIENT_SECRET");
  if (!stateSecret || !clientId || !clientSecret) return back(appUrl, { strava: "not_configured" });

  const userId = await readState(stateSecret, state);
  if (!userId || !code) return back(appUrl, { strava: "bad_state" });

  /* Strava requires the granted scopes to be checked rather than assumed: a
     rider can untick activity access on the approval screen and still be sent
     back here with a working token that reads nothing. */
  const granted = url.searchParams.get("scope") ?? "";
  if (!granted.includes("activity:read")) return back(appUrl, { strava: "no_activity_scope" });

  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, grant_type: "authorization_code" }),
  });
  if (!res.ok) return back(appUrl, { strava: "exchange_failed" });
  const tok = await res.json();

  // Service role: rider_link_secrets has RLS on and no policies, so this is
  // the only way in, and it is the only place tokens are ever touched.
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { error: secErr } = await admin.from("rider_link_secrets").upsert({
    user_id: userId, provider: "strava",
    access_token: tok.access_token, refresh_token: tok.refresh_token,
    expires_at: new Date((tok.expires_at ?? 0) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  });
  if (secErr) return back(appUrl, { strava: "store_failed" });

  await admin.from("rider_links").upsert({
    user_id: userId, provider: "strava",
    athlete_id: String(tok.athlete?.id ?? ""), scopes: granted,
    connected_at: new Date().toISOString(), last_error: null,
  });

  return back(appUrl, { strava: "connected" });
});
