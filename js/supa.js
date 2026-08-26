import { createClient } from "./vendor/supabase.js";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

export const supa = createClient(SUPABASE_URL, SUPABASE_KEY);

export async function currentUser() {
  const { data } = await supa.auth.getSession();
  return data.session?.user ?? null;
}
