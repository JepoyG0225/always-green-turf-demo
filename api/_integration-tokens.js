// Persistent OAuth refresh-token store (Supabase). QBO and Jobber both rotate
// their refresh token on every use, so the live value must be saved each time.
const SUPA = process.env.SUPABASE_URL || "https://otgpzpepmurbydcghygb.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

async function getToken(service) {
  const r = await fetch(`${SUPA}/rest/v1/integration_tokens?service=eq.${encodeURIComponent(service)}&select=refresh_token`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] ? rows[0].refresh_token : null;
}

async function saveToken(service, refresh_token) {
  const r = await fetch(`${SUPA}/rest/v1/integration_tokens?on_conflict=service`, {
    method: "POST",
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ service, refresh_token, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error(`token save ${r.status}: ${(await r.text()).slice(0, 160)}`);
}

module.exports = { getToken, saveToken };
