// Publish / unpublish a workflow — admin only.
// The /dispatch UI sends the signed-in user's Supabase token; we verify it,
// then upsert workflow_config with the service-role key.
//   POST /api/workflow-toggle  { workflow, published:boolean }  + Bearer <session token>
const SUPA = process.env.SUPABASE_URL || "https://otgpzpepmurbydcghygb.supabase.co";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im90Z3B6cGVwbXVyYnlkY2doeWdiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDUyNDEsImV4cCI6MjA4NjMyMTI0MX0.5QpLZ7a9nebe5MYL44GrUFfS3MB7vRy-IPtCZtrorvo";

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
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
  const workflow = String(body.workflow || "").trim();
  const published = body.published !== false;
  if (!workflow) { res.status(400).json({ error: "workflow required" }); return; }

  const r = await fetch(`${SUPA}/rest/v1/workflow_config?on_conflict=workflow`, {
    method: "POST",
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ workflow, published, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) { res.status(502).json({ error: `save failed: ${r.status}` }); return; }
  console.log("[workflow-toggle] " + JSON.stringify({ ts: new Date().toISOString(), by: user.email, workflow, published }));
  res.status(200).json({ ok: true, workflow, published });
};
