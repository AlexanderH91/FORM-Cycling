/* Step one of connecting Strava: hand the signed-in rider a URL to approve.
 *
 * The client id is public, but the SECRET never appears here or anywhere the
 * browser can reach — the exchange happens in strava-callback. This function
 * exists only so the state parameter can be signed with a key the client does
 * not have. */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { signState } from "./state.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const clientId = Deno.env.get("STRAVA_CLIENT_ID");
  const stateSecret = Deno.env.get("LINK_STATE_SECRET");
  if (!clientId || !stateSecret) {
    // Say which piece is missing rather than failing as a bare 500 — this is
    // the first thing that will be wrong on a fresh deploy.
    return json({ error: "not_configured",
      message: "Strava is not set up on this server yet (STRAVA_CLIENT_ID / LINK_STATE_SECRET)." }, 503);
  }

  const auth = req.headers.get("Authorization") ?? "";
  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: auth } } });
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return json({ error: "not_signed_in" }, 401);

  const redirectUri = `${Deno.env.get("SUPABASE_URL")}/functions/v1/strava-callback`;
  const url = new URL("https://www.strava.com/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("approval_prompt", "auto");
  // Only what FORM actually reads: the rider's own activities, including the
  // private ones, and nothing that can write to their Strava.
  url.searchParams.set("scope", "read,activity:read_all");
  url.searchParams.set("state", await signState(stateSecret, user.id));
  return json({ url: url.toString() });
});
