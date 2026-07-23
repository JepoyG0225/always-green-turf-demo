// Delete workflow_runs rows — admin only.
// The admin UI sends the signed-in user's Supabase token; we verify it, then
// delete with the service-role key.
//   POST /api/runs-delete   { ids: [...] }              delete specific runs
//                           { workflow: "x", all: true } delete ALL runs for one workflow
//   header: Authorization: Bearer <supabase user access token>
const SUPA = process.env.SUPABASE_URL || "https://otgpzpepmurbydcghygb.supabase.co";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im90Z3B6cGVwbXVyYnlkY2doeWdiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDUyNDEsImV4cCI6MjA4NjMyMTI0MX0.5QpLZ7a9nebe5MYL44GrUFfS3MB7vRy-IPtCZtrorvo";

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
  let query;
  if (body.all === true && body.workflow) {
    // scoped delete-all: only rows for the named workflow (never the whole table)
    query = `workflow=eq.${encodeURIComponent(String(body.workflow))}`;
  } else if (Array.isArray(body.ids) && body.ids.length) {
    const ids = body.ids.map(String).filter((x) => /^[0-9a-f-]{1,40}$/i.test(x));
    if (!ids.length) { res.status(400).json({ error: "no valid ids" }); return; }
    query = `id=in.(${ids.join(",")})`;
  } else {
    res.status(400).json({ error: "provide ids[] or { workflow, all:true }" }); return;
  }

  const del = await fetch(`${SUPA}/rest/v1/workflow_runs?${query}`, {
    method: "DELETE",
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, Prefer: "count=exact" },
  });
  if (!del.ok) { res.status(502).json({ error: `delete failed: ${del.status}` }); return; }
  const deleted = Number((del.headers.get("content-range") || "").split("/")[1] || 0) || null;

  console.log("[runs-delete] " + JSON.stringify({ ts: new Date().toISOString(), by: user.email, all: body.all === true, workflow: body.workflow, ids: body.all ? null : body.ids, deleted }));
  res.status(200).json({ ok: true, deleted });
};
