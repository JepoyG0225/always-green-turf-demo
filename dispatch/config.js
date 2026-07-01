// DispatchAI admin — reuses the SAME Supabase client the time-off app uses
// (js/supabase-client.js), so /dispatch shares its project, anon key, and login
// session. Sign in once and both /admin and /dispatch work. No secrets here.
export { supabase } from "../js/supabase-client.js";
export { SUPABASE_URL } from "../js/site-config.js";

import { supabase } from "../js/supabase-client.js";

/** Redirect to login if there's no active session. Returns the session or null. */
export async function requireSession() {
  const { data } = await supabase.auth.getSession();
  if (!data?.session) { window.location.replace("/dispatch/login"); return null; }
  return data.session;
}

export async function signOut() {
  await supabase.auth.signOut();
  window.location.replace("/dispatch/login");
}

export function fmtPhx(iso, opts) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", { timeZone: "America/Phoenix", ...(opts || { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) });
}
