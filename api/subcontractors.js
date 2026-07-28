// Subcontractors CRUD + QBO vendor search — admin only.
//   GET  /api/subcontractors                       → list all
//   POST /api/subcontractors { action, ... }        + Bearer <session token>
//        action: "create" | "update" | "delete" | "search-vendors"
const qbo = require("./_qbo");
const SUPA = process.env.SUPABASE_URL || "https://otgpzpepmurbydcghygb.supabase.co";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im90Z3B6cGVwbXVyYnlkY2doeWdiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDUyNDEsImV4cCI6MjA4NjMyMTI0MX0.5QpLZ7a9nebe5MYL44GrUFfS3MB7vRy-IPtCZtrorvo";
const H = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = []; for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return {}; }
}
async function verify(req) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const who = await fetch(`${SUPA}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
  return who.ok ? who.json() : null;
}
const clean = (v) => (v == null ? null : String(v).trim() || null);
function sanitize(row) {
  row = row || {};
  return {
    name: clean(row.name), qbo_vendor_id: clean(row.qbo_vendor_id), qbo_vendor_name: clean(row.qbo_vendor_name),
    email: clean(row.email), phone: clean(row.phone), active: row.active !== false,
  };
}

module.exports = async function handler(req, res) {
  if (!SERVICE) { res.status(500).json({ error: "service key not configured" }); return; }
  if (req.method === "GET") {
    const r = await fetch(`${SUPA}/rest/v1/subcontractors?select=*&order=name.asc`, { headers: H });
    const rows = await r.json().catch(() => []);
    res.status(r.ok ? 200 : 502).json(r.ok ? { ok: true, rows } : { error: "read failed" });
    return;
  }
  if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }
  const user = await verify(req);
  if (!user) { res.status(401).json({ error: "unauthorized" }); return; }
  const body = await readBody(req);
  const action = String(body.action || "").trim();

  try {
    if (action === "search-vendors") {
      const at = await qbo.accessToken();
      const rlm = await qbo.realm();
      const vendors = await qbo.findVendors(at, rlm, body.q || "");
      res.status(200).json({ ok: true, vendors: vendors.map((v) => ({ id: v.Id, name: v.DisplayName, email: v.PrimaryEmailAddr && v.PrimaryEmailAddr.Address })) });
      return;
    }
    if (action === "create") {
      const row = sanitize(body.row);
      if (!row.name) { res.status(400).json({ error: "name required" }); return; }
      const r = await fetch(`${SUPA}/rest/v1/subcontractors`, { method: "POST", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(row) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(JSON.stringify(out).slice(0, 200));
      res.status(200).json({ ok: true, row: Array.isArray(out) ? out[0] : out });
      return;
    }
    if (action === "update") {
      const id = String(body.id || ""); if (!id) { res.status(400).json({ error: "id required" }); return; }
      const row = sanitize(body.row); row.updated_at = new Date().toISOString();
      const r = await fetch(`${SUPA}/rest/v1/subcontractors?id=eq.${id}`, { method: "PATCH", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(row) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(JSON.stringify(out).slice(0, 200));
      res.status(200).json({ ok: true, row: Array.isArray(out) ? out[0] : out });
      return;
    }
    if (action === "delete") {
      const id = String(body.id || ""); if (!id) { res.status(400).json({ error: "id required" }); return; }
      const r = await fetch(`${SUPA}/rest/v1/subcontractors?id=eq.${id}`, { method: "DELETE", headers: { ...H, Prefer: "return=minimal" } });
      if (!r.ok) throw new Error(`delete ${r.status}`);
      res.status(200).json({ ok: true });
      return;
    }
    res.status(400).json({ error: `unknown action: ${action}` });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
