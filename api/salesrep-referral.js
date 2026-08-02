// Sales-rep referral form (/salesrep-referral) → GHL contact + opportunity.
//
// Creates/updates the contact, tags it for the rep who referred it, then drops
// an opportunity into the Call Center pipeline at the "Sales Rep Referral"
// stage. The pipeline and stage are resolved by NAME at request time, so
// renaming/rebuilding them in GHL doesn't need a code change (ids would).
//
// The submitted details (property type, size, service) are written as a contact
// note — best effort, since a failed note must not lose the lead.
//
// GET/POST ?dryRun=1 resolves the pipeline + stage and reports what it found
// without writing anything.

const upsertGhlContact = require("./_ghl-contact");

const TOKEN = process.env.GHL_API_TOKEN || "";
const LOC = process.env.GHL_LOCATION_ID || "dpp7zOnwhkHGWhn5lGRd";
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_CHANNEL = process.env.SLACK_REFERRAL_CHANNEL || "C096A9CR62Y"; // #workflow-testing
const PIPELINE_NAME = process.env.GHL_REFERRAL_PIPELINE || "Call Center";
const STAGE_NAME = process.env.GHL_REFERRAL_STAGE || "Sales Rep Referral";
const H = { Authorization: `Bearer ${TOKEN}`, Version: "2021-07-28", Accept: "application/json" };

// The rep list and its tags live here, not in the page: the tag is what the
// GHL automations key off, so the browser must not be able to choose it.
const REPS = {
  "Aaron Heimes": "#salesrepreferralah",
  "Aaron Karkhoff": "#salesrepreferralak",
  "Ammon Duffin": "#salesrepreferralammon",
  "James Haney": "#salesrepreferraljames",
  "Jason Koening": "#salesrepreferraljason",
  "Karina Chandler": "#salesrepreferralkarina",
};

const SERVICES = [
  "Turf Only",
  "Turf and Pavers",
  "Turf, Gravel, Rock, Pavers, Travertine",
  "Turf / Pergolas / Putting Green",
  "Irrigation / Paver Border",
];

const PROPERTY_TYPES = ["Residential", "HOA Property", "Commercial"];

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return {}; }
}

const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

// Pipeline ids are stable for the life of a lambda instance — resolve once.
let pipelineCache = null;
async function resolveStage() {
  if (pipelineCache) return pipelineCache;
  const r = await fetch(`https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${LOC}`, { headers: H });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GHL pipelines ${r.status}: ${d.message || JSON.stringify(d).slice(0, 200)}`);
  const pipelines = d.pipelines || [];
  const pipeline = pipelines.find((p) => norm(p.name) === norm(PIPELINE_NAME));
  if (!pipeline) throw new Error(`GHL pipeline "${PIPELINE_NAME}" not found (have: ${pipelines.map((p) => p.name).join(", ") || "none"})`);
  const stage = (pipeline.stages || []).find((s) => norm(s.name) === norm(STAGE_NAME));
  if (!stage) throw new Error(`Stage "${STAGE_NAME}" not found in "${pipeline.name}" (have: ${(pipeline.stages || []).map((s) => s.name).join(", ") || "none"})`);
  pipelineCache = { pipelineId: pipeline.id, pipelineName: pipeline.name, stageId: stage.id, stageName: stage.name };
  return pipelineCache;
}

async function createOpportunity({ name, contactId, pipelineId, stageId }) {
  const r = await fetch("https://services.leadconnectorhq.com/opportunities/", {
    method: "POST",
    headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({ locationId: LOC, pipelineId, pipelineStageId: stageId, name, status: "open", contactId }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GHL opportunity ${r.status}: ${d.message || JSON.stringify(d).slice(0, 200)}`);
  return (d.opportunity && d.opportunity.id) || d.id || null;
}

// Never let a Slack outage cost us the lead — notification is best effort.
async function notifySlack(text) {
  if (!SLACK_TOKEN) return { sent: false, error: "SLACK_BOT_TOKEN not set" };
  try {
    const r = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${SLACK_TOKEN}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: SLACK_CHANNEL, text }),
    });
    const d = await r.json().catch(() => ({}));
    return { sent: !!d.ok, error: d.ok ? null : d.error || `HTTP ${r.status}` };
  } catch (e) { return { sent: false, error: String(e.message || e) }; }
}

async function addNote(contactId, body) {
  const r = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/notes`, {
    method: "POST",
    headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
  if (!r.ok) throw new Error(`GHL note ${r.status}: ${(await r.text()).slice(0, 160)}`);
}

module.exports = async function handler(req, res) {
  const dryRun = (req.query && req.query.dryRun === "1");
  if (dryRun) {
    try { res.status(200).json({ ok: true, dryRun: true, ...(await resolveStage()), reps: REPS }); }
    catch (e) { res.status(500).json({ ok: false, dryRun: true, error: String(e.message || e) }); }
    return;
  }
  if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }
  if (!TOKEN) { res.status(500).json({ error: "GHL is not configured (GHL_API_TOKEN missing)." }); return; }

  const b = await readBody(req);
  if (b.company) { res.status(200).json({ ok: true }); return; } // honeypot

  const firstName = String(b.firstName || "").trim();
  const lastName = String(b.lastName || "").trim();
  const email = String(b.email || "").trim();
  const phone = String(b.phone || "").trim();
  const street = String(b.street || "").trim();
  const salesRep = String(b.salesRep || "").trim();
  const service = String(b.service || "").trim();
  const propertyType = String(b.propertyType || "").trim();
  const areaSize = String(b.areaSize || "").trim();
  const referrer = String(b.referrer || "").trim();

  const missing = ["firstName", "lastName", "email", "phone", "street", "salesRep", "service", "propertyType", "areaSize"]
    .filter((k) => !String(b[k] || "").trim());
  if (missing.length) { res.status(400).json({ error: `Missing required field(s): ${missing.join(", ")}` }); return; }

  // The rep drives the tag, so an unknown one is a hard error rather than an
  // untagged lead nobody is watching.
  const repTag = REPS[salesRep];
  if (!repTag) { res.status(400).json({ error: `Unknown sales rep "${salesRep}".` }); return; }
  if (!SERVICES.includes(service)) { res.status(400).json({ error: `Unknown service "${service}".` }); return; }
  if (!PROPERTY_TYPES.includes(propertyType)) { res.status(400).json({ error: `Unknown property type "${propertyType}".` }); return; }

  try {
    // Contact first, always. The opportunity needs an extra GHL scope, and a
    // referral that lands as a tagged contact is recoverable — one that 500s
    // back at the rep is lost.
    const contact = await upsertGhlContact({
      firstName, lastName, email, phone,
      address1: street,
      city: String(b.city || "").trim(),
      state: String(b.state || "").trim(),
      postalCode: String(b.postalCode || "").trim(),
      tags: [repTag],
      source: `Sales Rep Referral — ${salesRep}`,
    });
    if (!contact.id) throw new Error("GHL upsert returned no contact id");

    let opportunityId = null, opportunityError = null, stage = null;
    try {
      stage = await resolveStage();
      opportunityId = await createOpportunity({
        name: `${firstName} ${lastName} — Sales Rep Referral (${salesRep})`,
        contactId: contact.id,
        pipelineId: stage.pipelineId,
        stageId: stage.stageId,
      });
    } catch (e) { opportunityError = String(e.message || e); console.error("[salesrep-referral] opportunity failed:", opportunityError); }

    // Details GHL has no first-class field for. Never fatal.
    let noteError = null;
    try {
      await addNote(contact.id, [
        `Sales Rep Referral — submitted via /salesrep-referral`,
        `Referred by: ${salesRep}`,
        `Service: ${service}`,
        `Property type: ${propertyType}`,
        `Approx. area: ${areaSize}`,
        `Address: ${[street, b.city, b.state, b.postalCode].filter(Boolean).join(", ")}`,
        referrer ? `Referrer param: ${referrer}` : "",
      ].filter(Boolean).join("\n"));
    } catch (e) { noteError = String(e.message || e); console.error("[salesrep-referral] note failed:", noteError); }

    const slack = await notifySlack([
      `🌱 *New Sales Rep Referral*`,
      `*Customer:* ${firstName} ${lastName} <${email}> · ${phone}`,
      `*Referred by:* ${salesRep}  \`${repTag}\``,
      `*Service:* ${service}`,
      `*Property:* ${propertyType} · ${areaSize}`,
      `*Address:* ${[street, b.city, b.state, b.postalCode].filter(Boolean).join(", ")}`,
      `*GHL contact:* <https://app.gohighlevel.com/v2/location/${LOC}/contacts/detail/${contact.id}|${contact.new ? "created" : "updated"}>`,
      opportunityId
        ? `*Pipeline:* ${stage.pipelineName} → ${stage.stageName}`
        : `⚠️ *Pipeline:* not added — ${opportunityError}`,
    ].join("\n"));

    console.log("[salesrep-referral] " + JSON.stringify({ ts: new Date().toISOString(), contactId: contact.id, opportunityId, salesRep, repTag, service, opportunityError, noteError, slack }));
    res.status(200).json({
      ok: true, contactId: contact.id, contactNew: contact.new, tag: repTag,
      opportunityId, pipeline: stage && stage.pipelineName, stage: stage && stage.stageName,
      opportunityError, noteError, slack,
    });
  } catch (e) {
    const msg = String(e.message || e);
    console.error("[salesrep-referral] failed:", msg);
    res.status(502).json({ error: msg });
  }
};

module.exports.REPS = REPS;
module.exports.SERVICES = SERVICES;
