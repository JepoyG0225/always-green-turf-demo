// Generate a subcontractor takeoff for a completed job: pull the job's ArcSite
// labor lines and attach the agreed cost from labor_rates. Materials are left
// out — subs only bill labor. No QBO writes here; the project is resolved at
// approval/bill time so nothing hits the books until a human approves.
const jobber = require("./_jobber");
const { jobberGql } = require("./_jobber-job");

const ARCSITE_TOKEN = process.env.ARCSITE_TOKEN || "";
const SUPA = process.env.SUPABASE_URL || "https://otgpzpepmurbydcghygb.supabase.co";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const H = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const money = (n) => Number(num(n, 0).toFixed(2));
const norm = (s) => String(s || "").toLowerCase().replace(/["'`]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

async function arcsite(method, path, body) {
  const r = await fetch(`https://api.arcsite.com/v1${path}`, {
    method, headers: { Authorization: `Bearer ${ARCSITE_TOKEN}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) throw new Error(`ArcSite ${method} ${path} → ${r.status}`);
  return r.json().catch(() => null);
}

const JOB_QUERY = `query($id:EncodedId!){ job(id:$id){ id jobNumber title
  client{ id name firstName lastName companyName emails{ address } }
  property{ address{ street1 street2 city province postalCode country } } } }`;

// The agreed labor rate card, indexed by ArcSite product id and by name.
async function laborRates() {
  const r = await fetch(`${SUPA}/rest/v1/labor_rates?select=*`, { headers: H });
  const rows = await r.json().catch(() => []);
  const byPid = new Map(), byName = new Map();
  for (const x of rows) {
    if (x.arcsite_product_id) byPid.set(String(x.arcsite_product_id), x);
    byName.set(norm(x.item), x);
    if (x.description) byName.set(norm(`${x.item} ${x.description}`), x);
  }
  return { rows, byPid, byName };
}

// Find the client's ArcSite drawing and return its raw line items. ArcSite
// projects are named by address, so /projects/search?project_name acts as a
// keyword filter — we search the surname (most distinctive) and the cleaned
// full name, then confirm the project's customer name matches the client.
async function findArcsiteLines(clientName) {
  const cleanName = String(clientName).replace(/\s+/g, " ").trim();
  const want = norm(cleanName);
  const tokens = cleanName.split(" ");
  const surname = tokens[tokens.length - 1] || cleanName;
  const queries = [...new Set([surname, cleanName])].filter(Boolean);
  for (const qy of queries) {
    const s = await arcsite("POST", "/projects/search", { project_name: qy }).catch(() => null);
    const list = Array.isArray(s) ? s : (s && (s.projects || s.data)) || [];
    // Prefer projects whose customer name matches the Jobber client.
    const ranked = list.filter((p) => !p.archived).sort((a, b) => {
      const am = norm((a.customer || {}).name), bm = norm((b.customer || {}).name);
      const as = am === want ? 2 : (am.includes(want) || want.includes(am)) && am ? 1 : 0;
      const bs = bm === want ? 2 : (bm.includes(want) || want.includes(bm)) && bm ? 1 : 0;
      return bs - as;
    });
    for (const p of ranked) {
      const cn = norm((p.customer || {}).name);
      const nameOk = cn && (cn === want || cn.includes(want) || want.includes(cn));
      if (!nameOk && queries.length > 1) continue; // require a customer-name confirmation
      const drs = await arcsite("GET", `/projects/${p.id}/drawings`).catch(() => []);
      if (Array.isArray(drs) && drs.length) {
        const li = await arcsite("GET", `/drawings/${drs[0].id}/line_items`).catch(() => null);
        const src = Array.isArray(li) ? li[0] : li;
        const items = (src && src.line_items) || [];
        if (items.length) return { projectId: p.id, projectName: p.name, drawingId: drs[0].id, items, customer: (p.customer || {}).name };
      }
    }
  }
  return null;
}

// Match an ArcSite line to a labor rate: product id first (exact), then name.
function matchRate(li, rates) {
  const pid = li.product_id != null ? String(li.product_id) : "";
  if (pid && rates.byPid.has(pid)) return rates.byPid.get(pid);
  const n = norm(li.name);
  if (rates.byName.has(n)) return rates.byName.get(n);
  return null;
}

// Build the labor line items (only lines that map to an agreed rate).
function buildLines(arcItems, rates) {
  const lines = [];
  for (const li of arcItems) {
    const rate = matchRate(li, rates);
    if (!rate) continue; // material or unpriced → not a sub labor line
    const qty = num(li.quantity, 1);
    const agreed = num(rate.cost, 0);
    lines.push({
      name: li.name || rate.item,
      arcsite_product_id: li.product_id != null ? String(li.product_id) : (rate.arcsite_product_id || null),
      qty, unit: rate.unit || li.unit || null,
      agreed_cost: agreed,
      line_total: money(agreed * qty),
      confirmed: true,
      override_cost: null, override_comment: null, override_image_url: null,
    });
  }
  return lines;
}

function token() {
  // URL-safe random token (no Math.random dependency issues in prod).
  return "tk_" + require("crypto").randomBytes(18).toString("base64url");
}

// Generate (or preview) a takeoff for a Jobber job + subcontractor.
async function generate({ jobId, subcontractorId, dryRun }) {
  if (!jobId) throw new Error("jobId required");
  const at = await jobber.accessToken();
  const d = await jobberGql(at, JOB_QUERY, { id: jobId });
  const job = d.job;
  if (!job) throw new Error("Jobber job not found");
  const clientName = (job.client && (job.client.companyName || job.client.name || [job.client.firstName, job.client.lastName].filter(Boolean).join(" "))) || "";

  const rates = await laborRates();
  if (!rates.rows.length) throw new Error("labor_rates is empty — load the price sheet first");
  const arc = await findArcsiteLines(clientName);
  if (!arc) throw new Error(`No ArcSite drawing found for "${clientName}"`);
  const lines = buildLines(arc.items, rates);
  if (!lines.length) throw new Error(`No labor lines matched the rate card for "${clientName}" (${arc.items.length} ArcSite lines)`);
  const total = money(lines.reduce((s, l) => s + l.line_total, 0));

  const record = {
    job_id: jobId,
    job_number: job.jobNumber,
    client_name: clientName,
    arcsite_drawing_id: arc.drawingId,
    subcontractor_id: subcontractorId || null,
    line_items: lines,
    total_amount: total,
    status: "sent",
  };

  if (dryRun) {
    return { ok: true, dryRun: true, clientName, jobNumber: job.jobNumber, arcsiteProject: arc.projectName,
      arcsiteLineCount: arc.items.length, matchedLines: lines.length, total, lines };
  }

  record.token = token();
  const r = await fetch(`${SUPA}/rest/v1/sub_takeoffs`, { method: "POST", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(record) });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`create takeoff ${r.status}: ${JSON.stringify(out).slice(0, 200)}`);
  const row = Array.isArray(out) ? out[0] : out;
  return { ok: true, id: row.id, token: row.token, jobNumber: job.jobNumber, clientName, matchedLines: lines.length, total };
}

module.exports = { generate, buildLines, findArcsiteLines, laborRates };
