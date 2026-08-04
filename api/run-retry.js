// Re-run a workflow execution from the Executions viewer — admin only.
//
// Takes a workflow_runs row, reads the trigger payload it was originally fired
// with, and puts it back through the same workflow. Used to recover runs that
// failed for a reason since fixed (a bad payload mapping, an expired token, a
// third-party outage) without waiting for the source system to re-send.
//
// Only runs that ended in "error" can be replayed: any other outcome may have
// already written to QBO or Jobber, and re-running one of those could double
// up (a payment applied twice, an invoice mirrored twice).
//
// The retry is a fresh run: it writes its own workflow_runs row, so the failed
// original stays in the history rather than being overwritten.
//
//   POST /api/run-retry   { id: "<run uuid>", dryRun?: true }
//   header: Authorization: Bearer <supabase user access token>

const SUPA = process.env.SUPABASE_URL || "https://otgpzpepmurbydcghygb.supabase.co";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im90Z3B6cGVwbXVyYnlkY2doeWdiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDUyNDEsImV4cCI6MjA4NjMyMTI0MX0.5QpLZ7a9nebe5MYL44GrUFfS3MB7vRy-IPtCZtrorvo";

// How each workflow is re-fired. Workflows with a run() module are called
// directly; the ones whose logic lives in the HTTP handler are re-posted to
// their own endpoint so the retry goes through exactly the same code path.
const RETRY = {
  "jobber-job": (t) => ({ mod: "./_jobber-job", args: { jobId: t.jobId }, needs: "jobId" }),
  "jobber-job-closed": (t) => ({ mod: "./_jobber-job-closed", args: { jobId: t.jobId }, needs: "jobId" }),
  "jobber-invoice": (t) => ({ mod: "./_jobber-invoice", args: { invoiceId: t.invoiceId }, needs: "invoiceId" }),
  "jobber-payment": (t) => ({ post: "/api/jobber-payment", body: { paymentId: t.paymentId, topic: t.topic || "PAYMENT_CREATE" }, needs: "paymentId" }),
  "arcsite-quote": (t) => ({ post: "/api/arcsite-quote", body: t, needs: null }),
};

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = []; for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return {}; }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }
  if (!SERVICE) { res.status(500).json({ error: "service key not configured" }); return; }

  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) { res.status(401).json({ error: "unauthorized" }); return; }
  const who = await fetch(`${SUPA}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
  if (!who.ok) { res.status(401).json({ error: "unauthorized" }); return; }
  const user = await who.json();

  const body = await readBody(req);
  const id = String(body.id || "");
  if (!/^[0-9a-f-]{10,40}$/i.test(id)) { res.status(400).json({ error: "valid run id required" }); return; }
  const dryRun = body.dryRun === true;

  const r = await fetch(`${SUPA}/rest/v1/workflow_runs?id=eq.${id}&select=id,workflow,status,summary,trigger_payload`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  });
  const rows = await r.json().catch(() => []);
  const run = Array.isArray(rows) ? rows[0] : null;
  if (!run) { res.status(404).json({ error: "run not found" }); return; }

  // Errored runs only. A run that finished any other way may have already
  // written to QBO/Jobber — re-running a payment that applied would apply it
  // twice — so those are deliberately not replayable from here.
  if (run.status !== "error") {
    res.status(400).json({ error: `only failed runs can be re-run (this one is "${run.status}")` });
    return;
  }

  const plan = RETRY[run.workflow];
  if (!plan) { res.status(400).json({ error: `"${run.workflow}" can't be retried automatically (retryable: ${Object.keys(RETRY).join(", ")})` }); return; }

  const trigger = run.trigger_payload || {};
  const spec = plan(trigger);
  if (spec.needs && !trigger[spec.needs]) {
    res.status(400).json({ error: `original run has no ${spec.needs} to retry with` });
    return;
  }

  console.log("[run-retry] " + JSON.stringify({ ts: new Date().toISOString(), by: user.email, id, workflow: run.workflow, dryRun }));

  try {
    let result;
    if (spec.mod) {
      result = await require(spec.mod).run({ ...spec.args, dryRun });
    } else {
      // Same host as this request, so the retry hits this deployment.
      const host = req.headers["x-forwarded-host"] || req.headers.host;
      const url = `https://${host}${spec.post}${dryRun ? "?dryRun=1" : ""}`;
      const rr = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...spec.body, ...(dryRun ? { dryRun: true } : {}) }) });
      result = await rr.json().catch(() => ({}));
      if (!rr.ok) throw new Error(result.error || `HTTP ${rr.status}`);
    }
    res.status(200).json({ ok: true, workflow: run.workflow, dryRun, result });
  } catch (e) {
    // The retry logs its own failed run; report the reason back to the UI.
    res.status(200).json({ ok: false, workflow: run.workflow, dryRun, error: String(e.message || e) });
  }
};
