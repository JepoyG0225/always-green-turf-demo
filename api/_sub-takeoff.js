// Generate a subcontractor takeoff for a completed Jobber job. The job's own
// line items are the source of truth (they reflect final scope / change orders,
// and avoid guessing which ArcSite drawing applies). Each line is matched to the
// agreed rate card by name; matched lines pre-fill the agreed cost, unmatched
// show $0 for the sub/admin to price. Discounts, fees and markup are excluded —
// they're not sub-billable. No QBO writes here; the project is resolved at
// approval/bill time so nothing hits the books until a human approves.
const jobber = require("./_jobber");
const { jobberGql } = require("./_jobber-job");

const SUPA = process.env.SUPABASE_URL || "https://otgpzpepmurbydcghygb.supabase.co";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const H = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const money = (n) => Number(num(n, 0).toFixed(2));
const norm = (s) => String(s || "").toLowerCase().replace(/["'`]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

// Lines that are never billable to a subcontractor.
const EXCLUDE = /(discount|processing fee|markup|deposit|tax)/i;

const JOB_QUERY = `query($id:EncodedId!){ job(id:$id){ id jobNumber title jobStatus
  client{ id name firstName lastName companyName emails{ address } }
  property{ address{ street1 street2 city province postalCode country } }
  visits(first:8){ nodes{ assignedUsers{ nodes{ name{ full } } } } }
  lineItems{ nodes{ id name description quantity unitPrice } } } }`;

// The distinct installer crew names Jobber recorded on a job's visits.
function jobCrewNames(job) {
  const names = new Set();
  for (const v of (job.visits && job.visits.nodes) || []) {
    for (const u of (v.assignedUsers && v.assignedUsers.nodes) || []) {
      const n = u.name && u.name.full; if (n) names.add(n.trim());
    }
  }
  return [...names];
}

// Resolve the subcontractor for a job from its crew, using each sub's mapped
// jobber_crew names. Returns { sub, crewNames, matchedCrew } (sub may be null).
async function resolveSubFromCrew(job) {
  const crewNames = jobCrewNames(job);
  if (!crewNames.length) return { sub: null, crewNames, matchedCrew: null };
  const r = await fetch(`${SUPA}/rest/v1/subcontractors?select=id,name,jobber_crew,active`, { headers: H });
  const raw = await r.json().catch(() => []);
  const subs = Array.isArray(raw) ? raw : []; // column may not exist yet → treat as none mapped
  const lc = crewNames.map((n) => n.toLowerCase());
  for (const s of subs) {
    const crews = Array.isArray(s.jobber_crew) ? s.jobber_crew : [];
    const hit = crews.find((c) => lc.includes(String(c).toLowerCase()));
    if (hit) return { sub: s, crewNames, matchedCrew: hit };
  }
  return { sub: null, crewNames, matchedCrew: null };
}

// The agreed labor rate card, indexed for name matching.
async function laborRates() {
  const r = await fetch(`${SUPA}/rest/v1/labor_rates?select=*`, { headers: H });
  const rows = await r.json().catch(() => []);
  return rows.map((x) => ({ ...x, _n: norm(x.item), _nd: x.description ? norm(`${x.item} ${x.description}`) : null }));
}

// Match a job line name to a rate: exact, then prefix either direction (so
// "Turf Install" ↔ "Turf Installation"), then description-qualified exact.
function matchRate(lineName, rates) {
  const n = norm(lineName);
  if (!n) return null;
  let hit = rates.find((r) => r._n === n || r._nd === n);
  if (hit) return hit;
  hit = rates.find((r) => r._n.length >= 4 && (n.startsWith(r._n) || r._n.startsWith(n)));
  if (hit) return hit;
  return null;
}

function buildLines(jobLines, rates) {
  const out = [];
  for (const li of jobLines) {
    if (EXCLUDE.test(li.name || "")) continue;
    const price = num(li.unitPrice, 0);
    if (price < 0) continue; // safety: skip credit lines
    const rate = matchRate(li.name, rates);
    const qty = num(li.quantity, 1);
    const agreed = rate ? num(rate.cost, 0) : 0;
    out.push({
      name: li.name || (rate && rate.item) || "Labor",
      jobber_line_id: li.id || null,
      matched: !!rate,
      arcsite_product_id: rate ? (rate.arcsite_product_id || null) : null,
      qty, unit: rate ? (rate.unit || null) : null,
      agreed_cost: agreed,
      line_total: money(agreed * qty),
      confirmed: !!rate, // matched labor starts checked; materials/unmatched start off
      override_cost: null, override_comment: null, override_image_url: null,
    });
  }
  return out;
}

function token() {
  return "tk_" + require("crypto").randomBytes(18).toString("base64url");
}

async function generate({ jobId, subcontractorId, dryRun }) {
  if (!jobId) throw new Error("jobId required");
  const at = await jobber.accessToken();
  const d = await jobberGql(at, JOB_QUERY, { id: jobId });
  const job = d.job;
  if (!job) throw new Error("Jobber job not found");
  const clientName = (job.client && (job.client.companyName || job.client.name || [job.client.firstName, job.client.lastName].filter(Boolean).join(" "))) || "";

  const rates = await laborRates();
  if (!rates.length) throw new Error("labor_rates is empty — load the price sheet first");
  const jobLines = (job.lineItems && job.lineItems.nodes) || [];
  const lines = buildLines(jobLines, rates);
  if (!lines.length) throw new Error(`Job #${job.jobNumber} has no billable labor lines`);
  const total = money(lines.reduce((s, l) => s + l.line_total, 0));
  const matched = lines.filter((l) => l.matched).length;

  // Auto-detect the subcontractor from the job's crew unless one was given.
  let subId = subcontractorId || null, detected = null;
  if (!subId) {
    const res = await resolveSubFromCrew(job);
    detected = { crewNames: res.crewNames, matchedCrew: res.matchedCrew, sub: res.sub ? { id: res.sub.id, name: res.sub.name } : null };
    if (res.sub) subId = res.sub.id;
  }

  const record = {
    job_id: jobId, job_number: job.jobNumber, client_name: clientName,
    subcontractor_id: subId,
    line_items: lines, total_amount: total, status: "sent",
  };

  if (dryRun) {
    return { ok: true, dryRun: true, clientName, jobNumber: job.jobNumber,
      jobLineCount: jobLines.length, billableLines: lines.length, matchedLines: matched, total, lines,
      crew: detected ? detected.crewNames : null, detectedSub: detected ? detected.sub : null, matchedCrew: detected ? detected.matchedCrew : null };
  }

  record.token = token();
  const r = await fetch(`${SUPA}/rest/v1/sub_takeoffs`, { method: "POST", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(record) });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`create takeoff ${r.status}: ${JSON.stringify(out).slice(0, 200)}`);
  const row = Array.isArray(out) ? out[0] : out;
  return { ok: true, id: row.id, token: row.token, jobNumber: job.jobNumber, clientName,
    matchedLines: matched, billableLines: lines.length, total,
    detectedSub: detected ? detected.sub : (subcontractorId ? { id: subcontractorId } : null),
    crew: detected ? detected.crewNames : null, matchedCrew: detected ? detected.matchedCrew : null };
}

module.exports = { generate, buildLines, laborRates, matchRate, resolveSubFromCrew, jobCrewNames };
