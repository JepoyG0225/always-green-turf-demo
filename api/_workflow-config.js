// Published/unpublished state for workflows (workflow_config table). Fail-open:
// if the table/row is missing or unreachable, treat the workflow as published.
const SUPA = process.env.SUPABASE_URL || "https://otgpzpepmurbydcghygb.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

async function isPublished(workflow) {
  if (!KEY) return true;
  try {
    const r = await fetch(`${SUPA}/rest/v1/workflow_config?workflow=eq.${encodeURIComponent(workflow)}&select=published`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
    });
    if (!r.ok) return true;
    const rows = await r.json();
    return rows.length ? rows[0].published !== false : true;
  } catch { return true; }
}

module.exports = { isPublished };
