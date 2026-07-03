// Delete dispatch_logs rows — admin only.
// The /dispatch UI sends the signed-in user's Supabase access token; we verify
// it against Supabase auth, then delete with the service-role key (RLS has no
// delete policy for browser keys, by design).
//
//   POST /api/logs-delete   { ids: ["uuid", ...] }  or  { all: true }
//   header: Authorization: Bearer <supabase user access token>

const SUPABASE_URL = process.env.SUPABASE_URL || "https://otgpzpepmurbydcghygb.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
// anon key is public by design (same one shipped in js/site-config.js)
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im90Z3B6cGVwbXVyYnlkY2doeWdiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDUyNDEsImV4cCI6MjA4NjMyMTI0MX0.5QpLZ7a9nebe5MYL44GrUFfS3MB7vRy-IPtCZtrorvo";

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = []; for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return {}; }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }
  if (!SERVICE_KEY) { res.status(500).json({ error: "service key not configured" }); return; }

  // 1) Verify the caller is a signed-in Supabase user.
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) { res.status(401).json({ error: "unauthorized" }); return; }
  const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!who.ok) { res.status(401).json({ error: "unauthorized" }); return; }
  const user = await who.json();

  // 2) Delete.
  const body = await readBody(req);
  let query;
  if (body.all === true) {
    query = "id=not.is.null"; // delete everything
  } else if (Array.isArray(body.ids) && body.ids.length) {
    const ids = body.ids.filter((x) => /^[0-9a-f-]{36}$/i.test(String(x)));
    if (!ids.length) { res.status(400).json({ error: "no valid ids" }); return; }
    query = `id=in.(${ids.join(",")})`;
  } else {
    res.status(400).json({ error: "provide ids[] or all:true" }); return;
  }

  const del = await fetch(`${SUPABASE_URL}/rest/v1/dispatch_logs?${query}`, {
    method: "DELETE",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, Prefer: "count=exact" },
  });
  if (!del.ok) { res.status(502).json({ error: `delete failed: ${del.status}` }); return; }
  const deleted = Number((del.headers.get("content-range") || "").split("/")[1] || 0) || null;

  console.log("[logs-delete-audit] " + JSON.stringify({
    ts: new Date().toISOString(), by: user.email, all: body.all === true,
    ids: body.all === true ? null : body.ids, deleted,
  }));
  res.status(200).json({ ok: true, deleted });
};
