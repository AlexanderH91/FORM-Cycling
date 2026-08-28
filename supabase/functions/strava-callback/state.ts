/* Deployed flat alongside index.ts, so it is a sibling import rather than a
   shared folder — the copy in the repo is exactly the copy that runs. */
/* A signed, expiring state parameter for the OAuth round trip.
 *
 * The callback arrives from Strava with no Supabase session — the browser is
 * coming back from another origin — so the only thing tying that redirect to a
 * rider is this state. It therefore has to be unforgeable: anyone who can mint
 * state can attach THEIR Strava account to SOMEONE ELSE's FORM account, or the
 * reverse. HMAC over user id and expiry, verified before anything is stored. */

const enc = new TextEncoder();

async function key(secret: string) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" },
    false, ["sign", "verify"]);
}

const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b as ArrayBuffer)))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

const unb64url = (s: string) =>
  Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

export async function signState(secret: string, userId: string, ttlSeconds = 600) {
  const body = `${userId}.${Date.now() + ttlSeconds * 1000}`;
  const sig = await crypto.subtle.sign("HMAC", await key(secret), enc.encode(body));
  return `${b64url(enc.encode(body))}.${b64url(sig)}`;
}

export async function readState(secret: string, state: string): Promise<string | null> {
  const [bodyPart, sigPart] = String(state ?? "").split(".");
  if (!bodyPart || !sigPart) return null;
  let body: string;
  try { body = new TextDecoder().decode(unb64url(bodyPart)); } catch { return null; }
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", await key(secret), unb64url(sigPart), enc.encode(body));
  } catch { return null; }
  if (!ok) return null;                                   // forged or tampered
  const [userId, expiry] = body.split(".");
  if (!userId || !expiry || Number(expiry) < Date.now()) return null;   // stale
  return userId;
}
