// GHL users for the location → for the "add sales rep" picker in /dispatch/reps.
// Returns [{ id, name, email }]; the `id` is the GHL user id used as assigned_id.
//
//   GET /api/ghl-users  ->  { users: [{ id, name, email }] }
//
// NOTE: the GHL token must have the "users.readonly" scope. If it doesn't, GHL
// returns 401 and this passes back a clear message.

const TOKEN = process.env.GHL_API_TOKEN || "";
const LOC = process.env.GHL_LOCATION_ID || "dpp7zOnwhkHGWhn5lGRd";

module.exports = async function handler(req, res) {
  if (!TOKEN) { res.status(500).json({ error: "GHL not configured (GHL_API_TOKEN missing)." }); return; }
  try {
    const r = await fetch(`https://services.leadconnectorhq.com/users/?locationId=${LOC}`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Version: "2021-07-28", Accept: "application/json" },
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const hint = r.status === 401 ? " Add the 'users.readonly' scope to the GHL token." : "";
      res.status(r.status).json({ error: `GHL users ${r.status}.${hint}`, detail: data && data.message });
      return;
    }
    const users = (data.users || [])
      .map((u) => ({
        id: u.id,
        name: u.name || [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.email || u.id,
        email: u.email || "",
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ users });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
};
