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
const { sendEmail } = require("./_email");

const SUPA = process.env.SUPABASE_URL || "https://otgpzpepmurbydcghygb.supabase.co";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im90Z3B6cGVwbXVyYnlkY2doeWdiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDUyNDEsImV4cCI6MjA4NjMyMTI0MX0.5QpLZ7a9nebe5MYL44GrUFfS3MB7vRy-IPtCZtrorvo";
const H = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || "https://always-green-turf-demo.vercel.app").replace(/\/$/, "");
const TAKEOFF_FROM = process.env.RESEND_FROM_SUBS || "Always Green Turf <jobs@alwaysgreenturfaz.com>";
const REPLY_TO = process.env.SUBS_REPLY_TO || "office@alwaysgreenturfaz.com";
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_CHANNEL = process.env.SLACK_JOB_COMPLETE_CHANNEL || process.env.SLACK_CHANNEL_ID || "C0BAZDCT5K4";
const money = (n) => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

async function notifySlack(text) {
  if (!SLACK_TOKEN) return;
  await fetch("https://slack.com/api/chat.postMessage", { method: "POST",
    headers: { Authorization: `Bearer ${SLACK_TOKEN}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: SLACK_CHANNEL, text }) }).catch(() => {});
}

function takeoffEmailHtml({ name, jobNumber, clientName, link }) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#14241c;">
    <div style="background:#1b5e3f;padding:20px 24px;border-radius:12px 12px 0 0;">
      <span style="color:#fff;font-size:18px;font-weight:800;">Always Green Turf</span>
    </div>
    <div style="border:1px solid #dde8e1;border-top:none;border-radius:0 0 12px 12px;padding:24px;">
      <p style="font-size:15px;margin:0 0 14px;">Hi${name ? " " + escapeHtml(name) : ""},</p>
      <p style="font-size:15px;line-height:1.55;margin:0 0 14px;">
        Job <b>#${escapeHtml(jobNumber)}</b>${clientName ? ` (${escapeHtml(clientName)})` : ""} is complete and ready for your billing.
        Please review the line items, confirm the work you performed, add photos of the finished job, and submit.
      </p>
      <p style="text-align:center;margin:24px 0;">
        <a href="${escapeHtml(link)}" style="background:#1b5e3f;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 26px;border-radius:10px;display:inline-block;">Review &amp; submit your takeoff</a>
      </p>
      <p style="font-size:13px;color:#5d7268;line-height:1.5;margin:0;">
        If the button doesn't work, paste this link into your browser:<br>
        <a href="${escapeHtml(link)}" style="color:#1b5e3f;word-break:break-all;">${escapeHtml(link)}</a>
      </p>
    </div>
    <p style="font-size:12px;color:#9aa89e;text-align:center;margin:14px 0;">This link is unique to your job — please don't forward it.</p>
  </div>`;
}
const escapeHtml = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Email the takeoff link to the sub; Slack-fallback if there's no email on file.
async function deliverTakeoff({ id, token, jobNumber, clientName, subcontractorId }) {
  const link = `${PUBLIC_BASE}/sub-takeoff?token=${token}`;
  let sub = null;
  if (subcontractorId) {
    const r = await fetch(`${SUPA}/rest/v1/subcontractors?id=eq.${subcontractorId}&select=name,email`, { headers: H });
    sub = (await r.json().catch(() => []))[0] || null;
  }
  if (!sub || !sub.email) {
    await notifySlack(`🧾 Takeoff ready — job #${jobNumber}${clientName ? ` (${clientName})` : ""}, but ${sub ? "no email on file for " + sub.name : "no subcontractor assigned"}. Send the link manually:\n${link}`);
    return { sent: false, reason: sub ? "no email on file" : "no subcontractor assigned", link };
  }
  await sendEmail({ to: sub.email, from: TAKEOFF_FROM, replyTo: REPLY_TO,
    subject: `Job #${jobNumber} — submit your takeoff`, html: takeoffEmailHtml({ name: sub.name, jobNumber, clientName, link }) });
  await fetch(`${SUPA}/rest/v1/sub_takeoffs?id=eq.${id}`, { method: "PATCH", headers: { ...H, Prefer: "return=minimal" },
    body: JSON.stringify({ sent_to: sub.email, sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }) });
  return { sent: true, to: sub.email, link };
}

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
      // Auto-deliver to the sub (email), unless the caller opts out.
      if (body.send !== false) {
        try { out.delivery = await deliverTakeoff({ id: out.id, token: out.token, jobNumber: out.jobNumber, clientName: out.clientName, subcontractorId: (out.detectedSub && out.detectedSub.id) || body.subcontractorId }); }
        catch (e) { out.delivery = { sent: false, reason: String(e.message || e), link: out.link }; }
      }
      res.status(200).json(out);
      return;
    }
    // Manually (re)send the takeoff link to the sub.
    if (action === "send") {
      const t = await getTakeoff(body.id);
      if (!t) { res.status(404).json({ error: "takeoff not found" }); return; }
      const delivery = await deliverTakeoff({ id: t.id, token: t.token, jobNumber: t.job_number, clientName: t.client_name, subcontractorId: t.subcontractor_id });
      res.status(delivery.sent ? 200 : 200).json({ ok: true, delivery });
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
