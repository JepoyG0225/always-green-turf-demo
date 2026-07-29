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
function crewList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string") return v.split(",").map((x) => x.trim()).filter(Boolean);
  return [];
}
function sanitize(row) {
  row = row || {};
  return {
    name: clean(row.name), qbo_vendor_id: clean(row.qbo_vendor_id), qbo_vendor_name: clean(row.qbo_vendor_name),
    email: clean(row.email), phone: clean(row.phone), jobber_crew: crewList(row.jobber_crew), active: row.active !== false,
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
    // Import real subcontractors from QBO: any vendor with a bill coded to
    // Contractors - COGS (acct 9) is, by definition, a sub we pay. Vendor id +
    // email come straight from QBO, so no manual mapping is needed. Idempotent:
    // only inserts vendors not already in the table.
    if (action === "import-from-qbo") {
      const at = await qbo.accessToken();
      const rlm = await qbo.realm();
      const COGS = process.env.QBO_CONTRACTORS_COGS || "9";
      // 1) scan bills, aggregate vendors that hit the Contractors-COGS account
      const vend = new Map();
      for (let pos = 1; pos < 5000; pos += 100) {
        const bills = (await qbo.query(at, rlm, `SELECT * FROM Bill STARTPOSITION ${pos} MAXRESULTS 100`)).Bill || [];
        if (!bills.length) break;
        for (const bl of bills) {
          const hit = (bl.Line || []).some((l) => (l.AccountBasedExpenseLineDetail && l.AccountBasedExpenseLineDetail.AccountRef && l.AccountBasedExpenseLineDetail.AccountRef.value) === COGS);
          if (!hit) continue;
          const v = bl.VendorRef || {}; if (!v.value) continue;
          const e = vend.get(v.value) || { id: v.value, name: v.name, count: 0, total: 0 };
          e.count++; e.total += Number(bl.TotalAmt || 0);
          vend.set(v.value, e);
        }
        if (bills.length < 100) break;
      }
      if (!vend.size) { res.status(200).json({ ok: true, found: 0, imported: 0, message: "No vendors billed to Contractors-COGS found" }); return; }
      // 2) enrich with email/phone from the Vendor records
      const ids = [...vend.keys()];
      const vdetail = (await qbo.query(at, rlm, `SELECT Id, DisplayName, PrimaryEmailAddr, PrimaryPhone FROM Vendor WHERE Id IN (${ids.map((i) => `'${i}'`).join(",")})`)).Vendor || [];
      const byId = new Map(vdetail.map((v) => [v.Id, v]));
      // 3) skip any already in the table
      const existing = await (await fetch(`${SUPA}/rest/v1/subcontractors?select=qbo_vendor_id`, { headers: H })).json().catch(() => []);
      const have = new Set((existing || []).map((s) => s.qbo_vendor_id).filter(Boolean));
      const toInsert = [...vend.values()].filter((v) => !have.has(v.id)).map((v) => {
        const d = byId.get(v.id) || {};
        return { name: d.DisplayName || v.name, qbo_vendor_id: v.id, qbo_vendor_name: d.DisplayName || v.name,
          email: (d.PrimaryEmailAddr && d.PrimaryEmailAddr.Address) || null,
          phone: (d.PrimaryPhone && d.PrimaryPhone.FreeFormNumber) || null, active: true };
      });
      let imported = 0;
      if (toInsert.length) {
        const r = await fetch(`${SUPA}/rest/v1/subcontractors`, { method: "POST", headers: { ...H, Prefer: "return=minimal" }, body: JSON.stringify(toInsert) });
        if (!r.ok) throw new Error(`insert ${r.status}: ${(await r.text()).slice(0, 200)}`);
        imported = toInsert.length;
      }
      res.status(200).json({ ok: true, found: vend.size, imported, skippedExisting: vend.size - toInsert.length,
        subs: [...vend.values()].sort((a, b) => b.total - a.total).map((v) => ({ name: v.name, vendorId: v.id, bills: v.count, total: Math.round(v.total), imported: !have.has(v.id) })) });
      return;
    }
    // Distinct installer crews Jobber recorded on recent closed jobs, with how
    // many jobs each did and whether it's already mapped to a sub — so the admin
    // can assign the unmapped ones.
    if (action === "list-crews") {
      const jobber = require("./_jobber");
      const { jobberGql } = require("./_jobber-job");
      const at = await jobber.accessToken();
      const d = await jobberGql(at, `query{ jobs(first:20, filter:{ status: archived }){ nodes{ visits(first:2){ nodes{ assignedUsers{ nodes{ name{ full } } } } } } } }`, {});
      const counts = new Map();
      for (const j of (d.jobs && d.jobs.nodes) || []) {
        const names = new Set();
        for (const v of (j.visits && j.visits.nodes) || []) for (const u of (v.assignedUsers && v.assignedUsers.nodes) || []) if (u.name && u.name.full) names.add(u.name.full.trim());
        for (const n of names) counts.set(n, (counts.get(n) || 0) + 1);
      }
      const subs = await (await fetch(`${SUPA}/rest/v1/subcontractors?select=name,jobber_crew`, { headers: H })).json().catch(() => []);
      const mapped = new Map();
      for (const s of subs) for (const c of (Array.isArray(s.jobber_crew) ? s.jobber_crew : [])) mapped.set(String(c).toLowerCase(), s.name);
      const crews = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, jobs]) => ({ name, jobs, mappedTo: mapped.get(name.toLowerCase()) || null }));
      res.status(200).json({ ok: true, crews });
      return;
    }
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
