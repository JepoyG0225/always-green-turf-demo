// Jobber JOB_CLOSED webhook → the two workflows that care about a closed job.
// Point Jobber's JOB_CLOSED topic at this URL.
//   POST { itemId | jobId } or a Jobber webhook body
//   ?dryRun=1            test without the publish checks
//   ?channel=#some-chan  dry run only — send the Slack post somewhere else
//
// Jobber allows one webhook per topic, so this is the single entry point. It is
// a dispatcher, not a merge: each workflow keeps its own publish switch, its own
// run log and its own retry. Nothing here decides whether either should run —
// they each check that for themselves.
//
// Order is deliberate. Invoicing goes first because it's the money-critical
// path: if the function runs out of time uploading photos to Slack, the invoice
// is already done. And the Slack post can never fail the invoice — its result is
// captured, not thrown.
const { run: runInvoice } = require("./_jobber-job-closed");
const { run: runJobComplete } = require("./_jobber-job-complete");

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
  // A channel override is dry-run only: a real run always posts to #job-complete.
  const channel = dryRun ? String((req.query && req.query.channel) || b.channel || "").trim() || null : null;

  // 1) Invoice + QBO.
  let invoice = null, invoiceError = null;
  try { invoice = await runInvoice({ jobId, dryRun }); }
  catch (e) { invoiceError = String(e.message || e); }

  // 2) Completion photos → Slack. Independent: its own workflow, and a failure
  //    here is reported rather than thrown so it can't affect the invoice above.
  let jobComplete = null, jobCompleteError = null;
  try { jobComplete = await runJobComplete({ jobId, dryRun, channel }); }
  catch (e) { jobCompleteError = String(e.message || e); }

  // Only an invoice failure returns 5xx — that's the one worth Jobber retrying.
  // A missed Slack post is visible in the run log and retryable by hand; making
  // Jobber redeliver for it would re-enter the invoice path for no reason.
  const status = invoiceError ? 500 : 200;
  res.status(status).json({
    ok: !invoiceError,
    jobId,
    invoice: invoiceError ? { ok: false, error: invoiceError } : invoice,
    jobComplete: jobCompleteError ? { ok: false, error: jobCompleteError } : jobComplete,
  });
};
