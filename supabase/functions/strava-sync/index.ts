/* Pull the rider's recent rides in, and nothing else.
 *
 * Summary figures only: no GPS streams, no polylines, no route. FORM wants to
 * know how you rode, not where you live. Strava's API agreement also forbids
 * putting any of this into an AI model, so ride rows are kept out of the
 * coach's payload entirely — see coach-token, which builds its own context
 * from the fit report and never reads this table. */
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const clientId = Deno.env.get("STRAVA_CLIENT_ID");
  const clientSecret = Deno.env.get("STRAVA_CLIENT_SECRET");
  if (!clientId || !clientSecret) return json({ error: "not_configured" }, 503);

  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return json({ error: "not_signed_in" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: sec } = await admin.from("rider_link_secrets")
    .select("access_token, refresh_token, expires_at").eq("user_id", user.id).eq("provider", "strava").maybeSingle();
  if (!sec) return json({ error: "not_connected" }, 404);

  let access = sec.access_token;
  // Strava access tokens last six hours. Refresh a minute early rather than
  // discovering it expired halfway through a page of results.
  if (!sec.expires_at || new Date(sec.expires_at).getTime() - 60_000 < Date.now()) {
    const r = await fetch("https://www.strava.com/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret,
        grant_type: "refresh_token", refresh_token: sec.refresh_token }),
    });
    if (!r.ok) {
      await admin.from("rider_links").update({ last_error: "refresh_failed" })
        .eq("user_id", user.id).eq("provider", "strava");
      return json({ error: "refresh_failed", message: "Strava would not renew the connection — reconnect it." }, 401);
    }
    const t = await r.json();
    access = t.access_token;
    await admin.from("rider_link_secrets").update({
      access_token: t.access_token, refresh_token: t.refresh_token,
      expires_at: new Date((t.expires_at ?? 0) * 1000).toISOString(), updated_at: new Date().toISOString(),
    }).eq("user_id", user.id).eq("provider", "strava");
  }

  /* Only rides since the newest one already stored. Strava's limits are
     modest (a few hundred calls per fifteen minutes for the whole app, shared
     by every rider), so a full re-pull on every visit would be rude and would
     eventually lock everyone out. */
  const { data: newest } = await admin.from("rides")
    .select("start_time").eq("user_id", user.id).eq("provider", "strava")
    .order("start_time", { ascending: false }).limit(1).maybeSingle();
  const after = newest ? Math.floor(new Date(newest.start_time).getTime() / 1000) : undefined;

  const q = new URLSearchParams({ per_page: "50" });
  if (after) q.set("after", String(after));
  const res = await fetch(`https://www.strava.com/api/v3/athlete/activities?${q}`,
    { headers: { Authorization: `Bearer ${access}` } });

  if (res.status === 429) {
    await admin.from("rider_links").update({ last_error: "rate_limited" })
      .eq("user_id", user.id).eq("provider", "strava");
    return json({ error: "rate_limited", message: "Strava is rate-limiting us. Try again in fifteen minutes." }, 429);
  }
  if (!res.ok) return json({ error: "fetch_failed", status: res.status }, 502);

  const acts = await res.json();
  const rides = (Array.isArray(acts) ? acts : [])
    .filter((a) => typeof a?.type === "string" && a.type.includes("Ride"))
    .map((a) => ({
      user_id: user.id, provider: "strava", provider_ride_id: String(a.id),
      start_time: a.start_date, name: a.name ?? null, sport: a.sport_type ?? a.type ?? null,
      indoor: !!a.trainer, elapsed_s: num(a.elapsed_time), moving_s: num(a.moving_time),
      distance_m: num(a.distance), elev_gain_m: num(a.total_elevation_gain),
      avg_watts: num(a.average_watts), weighted_watts: num(a.weighted_average_watts),
      device_watts: a.device_watts ?? null,
      avg_hr: num(a.average_heartrate), max_hr: num(a.max_heartrate),
      avg_cadence: num(a.average_cadence), kilojoules: num(a.kilojoules),
    }));

  if (rides.length) {
    const { error } = await admin.from("rides")
      .upsert(rides, { onConflict: "user_id,provider,provider_ride_id" });
    if (error) return json({ error: "store_failed", message: error.message }, 500);
  }
  await admin.from("rider_links").update({ last_sync_at: new Date().toISOString(), last_error: null })
    .eq("user_id", user.id).eq("provider", "strava");

  return json({ added: rides.length });
});
