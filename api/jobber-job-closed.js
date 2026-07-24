// Jobber JOB_CLOSED webhook → create the Jobber invoice, then the QBO invoice.
// Point Jobber's JOB_CLOSED topic at this URL.
//   POST { itemId | jobId } or a Jobber webhook body   (?dryRun=1 to test)
const { run } = require("./_jobber-job-closed");
async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = []; for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return {}; }
}
module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  const b = await readBody(req);
  const ev = (b.data && b.data.webHookEvent) || b.webHookEvent || {};
  const jobId = ev.itemId || b.itemId || b.jobId || "";
  const dryRun = (req.query && req.query.dryRun === "1") || b.dryRun === true;
  try { res.status(200).json(await run({ jobId, dryRun })); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
};
