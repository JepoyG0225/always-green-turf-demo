// Admin: subcontractor takeoffs — list, generate, review, approve→QBO Bill.
//   GET  /api/sub-takeoffs                      → list (newest first)
//   POST /api/sub-takeoffs { action, ... }       + Bearer <session token>
//        generate {jobId, subcontractorId?}  → create + (returns link)
//        approve  {id, dryRun?}              → create the QBO Bill, mark billed
//        reject   {id}                       → mark rejected
//        delete   {id}                       → remove
const st = require("./_sub-takeoff");
const qbo = require("./_qbo");
const { createBill } = require("./_qbo-bill");

const SUPA = process.env.SUPABASE_URL || "https://otgpzpepmurbydcghygb.supabase.co";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im90Z3B6cGVwbXVyYnlkY2doeWdiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDUyNDEsImV4cCI6MjA4NjMyMTI0MX0.5QpLZ7a9nebe5MYL44GrUFfS3MB7vRy-IPtCZtrorvo";
const H = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || "https://always-green-turf-demo.vercel.app").replace(/\/$/, "");

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
async function getTakeoff(id) {
  const r = await fetch(`${SUPA}/rest/v1/sub_takeoffs?id=eq.${id}&select=*`, { headers: H });
  const rows = await r.json().catch(() => []); return rows[0] || null;
}
async function patch(id, body) {
  const r = await fetch(`${SUPA}/rest/v1/sub_takeoffs?id=eq.${id}`, { method: "PATCH", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify({ ...body, updated_at: new Date().toISOString() }) });
  const rows = await r.json().catch(() => []); if (!r.ok) throw new Error(`update ${r.status}`); return Array.isArray(rows) ? rows[0] : rows;
}

module.exports = async function handler(req, res) {
  if (!SERVICE) { res.status(500).json({ error: "not configured" }); return; }

  if (req.method === "GET") {
    const r = await fetch(`${SUPA}/rest/v1/sub_takeoffs?select=*&order=created_at.desc&limit=200`, { headers: H });
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
    if (action === "generate") {
      const out = await st.generate({ jobId: body.jobId, subcontractorId: body.subcontractorId, dryRun: false });
      out.link = `${PUBLIC_BASE}/sub-takeoff?token=${out.token}`;
      res.status(200).json(out);
      return;
    }
    if (action === "reject") {
      await patch(body.id, { status: "rejected", reviewed_at: new Date().toISOString(), reviewed_by: user.email });
      res.status(200).json({ ok: true });
      return;
    }
    if (action === "delete") {
      const r = await fetch(`${SUPA}/rest/v1/sub_takeoffs?id=eq.${body.id}`, { method: "DELETE", headers: { ...H, Prefer: "return=minimal" } });
      if (!r.ok) throw new Error(`delete ${r.status}`);
      res.status(200).json({ ok: true });
      return;
    }
    if (action === "approve") {
      const t = await getTakeoff(body.id);
      if (!t) { res.status(404).json({ error: "takeoff not found" }); return; }
      if (t.status === "billed") { res.status(409).json({ error: `Already billed (QBO #${t.qbo_bill_doc || t.qbo_bill_id}).` }); return; }
      if (t.status !== "submitted") { res.status(409).json({ error: `Takeoff is "${t.status}" — only submitted takeoffs can be approved.` }); return; }

      // The sub → QBO vendor
      if (!t.subcontractor_id) throw new Error("no subcontractor set on this takeoff");
      const sr = await fetch(`${SUPA}/rest/v1/subcontractors?id=eq.${t.subcontractor_id}&select=*`, { headers: H });
      const sub = (await sr.json())[0];
      if (!sub || !sub.qbo_vendor_id) throw new Error("subcontractor has no QBO vendor mapped");

      // Resolve (or create) the QBO customer + project the bill is tagged to.
      const at = await qbo.accessToken();
      const rlm = await qbo.realm();
      const name = t.client_name;
      const customer = await qbo.findOrCreateCustomer(at, rlm, name);
      const project = await qbo.findOrCreateCustomer(at, rlm, name, { IsProject: true, ParentRef: { value: customer.Id } });

      const takeoffForBill = { ...t, qbo_vendor_id: sub.qbo_vendor_id, project_qbo_id: project.Id };
      const bill = await createBill(takeoffForBill, { vendorId: sub.qbo_vendor_id, dryRun: !!body.dryRun });
      if (body.dryRun) { res.status(200).json({ ok: true, dryRun: true, vendor: sub.qbo_vendor_name, project: project.Id, ...bill }); return; }

      const updated = await patch(t.id, { status: "billed", project_qbo_id: project.Id,
        qbo_bill_id: bill.billId, qbo_bill_doc: bill.docNumber, reviewed_at: new Date().toISOString(), reviewed_by: user.email });
      res.status(200).json({ ok: true, qboBill: bill.docNumber, total: bill.total, vendor: sub.qbo_vendor_name, row: updated });
      return;
    }
    res.status(400).json({ error: `unknown action: ${action}` });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
