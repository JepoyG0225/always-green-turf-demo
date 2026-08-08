// Read-only discount audit for a Jobber job.
//   GET/POST /api/jobber-audit?jobNumber=5163      (or ?jobId=<EncodedId>)
//
// Diagnostic only: no writes to Jobber or QBO, no run-log entry. Reads a job's
// quote, job and invoice line items and amounts, and reports which step lost a
// discount.
//
// Guarded by JOBBER_AUDIT_SECRET when that env var is set — pass it as
// ?secret= or an x-audit-secret header. Set it once this investigation is done,
// or delete this endpoint; it returns customer names.
const { auditJob } = require("./_jobber-audit");

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = []; for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return {}; }
}

module.exports = async function handler(req, res) {
  const q = req.query || {};
  const body = req.method === "POST" ? await readBody(req) : {};

  const secret = process.env.JOBBER_AUDIT_SECRET || "";
  if (secret) {
    const given = req.headers["x-audit-secret"] || q.secret || body.secret || "";
    if (given !== secret) { res.status(401).json({ error: "unauthorized" }); return; }
  }

  const jobNumber = q.jobNumber || body.jobNumber || "";
  const jobId = q.jobId || body.jobId || "";
  if (!jobNumber && !jobId) { res.status(400).json({ error: "jobNumber or jobId required" }); return; }

  try { res.status(200).json(await auditJob({ jobNumber, jobId })); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
};
