/* Connecting a rider's training platform, and importing a file when there is
   no platform to connect to. */
import { supa } from "../supa.js";
import { STRAVA_START, STRAVA_SYNC, GARMIN_STATUS } from "../config.js";

const RETURN = {
  connected: ["ok", "Strava connected. Pulling your rides in…"],
  cancelled: ["", "Strava connection cancelled — nothing was changed."],
  bad_state: ["err", "That connection link had expired. Start it again."],
  no_activity_scope: ["err", "Strava was connected without permission to read activities, so there is nothing to pull. Reconnect and leave the activity box ticked."],
  exchange_failed: ["err", "Strava refused the connection. Try again."],
  store_failed: ["err", "Connected to Strava, but saving it here failed. Try again."],
  not_configured: ["err", "Strava is not set up on this server yet."],
};

// The callback sends the browser back to #/profile?strava=<what happened>.
export function returnMessage() {
  const q = new URLSearchParams((location.hash.split("?")[1] ?? ""));
  const key = q.get("strava");
  return key && RETURN[key] ? { kind: RETURN[key][0], text: RETURN[key][1], key } : null;
}

export async function linkStatus() {
  const { data } = await supa.from("rider_links").select("provider, athlete_id, last_sync_at, last_error");
  const { count } = await supa.from("rides").select("id", { count: "exact", head: true });
  return { links: data ?? [], rides: count ?? 0 };
}

async function call(url) {
  const { data: { session } } = await supa.auth.getSession();
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${session?.access_token ?? ""}`, "Content-Type": "application/json" },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || body.error || `request failed (${res.status})`);
  return body;
}

export async function startStrava() {
  const { url } = await call(STRAVA_START);
  location.href = url;                       // hands off to Strava's own screen
}

export const syncStrava = () => call(STRAVA_SYNC);

/* Disconnecting has to remove the rides too. A rider revoking access and
   finding their data still sitting in the app would be right to be angry. */
export async function disconnectStrava() {
  await supa.from("rides").delete().eq("provider", "strava");
  await supa.from("rider_links").delete().eq("provider", "strava");
}

/* ---- Files, for the platforms that will not let us in ---------------------
   Garmin Connect exports .TCX and .GPX, both XML, both parseable here with no
   dependency and no upload — the file is read in the browser and only the
   summary numbers are stored, exactly as with Strava. */

const tag = (el, name) => el.getElementsByTagName(name);
const nums = (el, name) => [...tag(el, name)].map((n) => Number(n.textContent)).filter(Number.isFinite);

export function parseTcx(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (tag(doc, "parsererror").length) throw new Error("that file is not readable XML");
  const acts = [...tag(doc, "Activity")];
  if (!acts.length) throw new Error("no activity found in that file");
  const a = acts[0];
  const laps = [...tag(a, "Lap")];
  const sum = (name) => laps.reduce((t, l) => t + (nums(l, name)[0] ?? 0), 0);
  const avg = (vals) => (vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : null);

  const trackpoints = [...tag(a, "Trackpoint")];
  const hr = trackpoints.flatMap((t) => nums(t, "Value"));
  const cad = trackpoints.flatMap((t) => nums(t, "Cadence"));
  const watts = trackpoints.flatMap((t) => nums(t, "Watts"));
  const started = tag(a, "Id")[0]?.textContent;
  if (!started || Number.isNaN(Date.parse(started))) throw new Error("that file has no start time");

  return {
    provider: "file", provider_ride_id: `tcx:${started}`,
    start_time: new Date(started).toISOString(),
    name: a.getAttribute("Sport") ? `${a.getAttribute("Sport")} (imported)` : "Imported ride",
    sport: a.getAttribute("Sport") ?? "Ride",
    // A TCX carries no notion of indoors; a ride with no distance almost
    // certainly is one, and that is stated rather than assumed silently.
    indoor: sum("DistanceMeters") < 100,
    elapsed_s: Math.round(sum("TotalTimeSeconds")) || null,
    moving_s: Math.round(sum("TotalTimeSeconds")) || null,
    distance_m: sum("DistanceMeters") || null,
    avg_hr: avg(hr), max_hr: hr.length ? Math.max(...hr) : null,
    avg_cadence: avg(cad),
    avg_watts: avg(watts), device_watts: watts.length > 0,
  };
}

export async function importFile(file, userId) {
  const text = await file.text();
  const ride = parseTcx(text);
  const { error } = await supa.from("rides")
    .upsert({ ...ride, user_id: userId }, { onConflict: "user_id,provider,provider_ride_id" });
  if (error) throw new Error(error.message);
  await supa.from("rider_links").upsert({ user_id: userId, provider: "file",
    last_sync_at: new Date().toISOString() });
  return ride;
}

export { GARMIN_STATUS };
