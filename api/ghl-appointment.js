// GoHighLevel appointment webhook → Jobber (client + property + request/assessment)
// and ArcSite (project). Ported from the n8n "Send Appointment from GHL -> Jobber".
//
// Faithful to the n8n flow, with three intentional clean-ups (flagged):
//   1) end time is computed timezone-safely (n8n used machine-local getHours()).
//   2) "same-day existing request" reuse scans ALL fetched requests, not just the
//      first (n8n's code node only ever looked at the first).
//   3) ONE ArcSite project is created (n8n created a duplicate under the generic
//      account in two sub-branches).
//
// Dry run: POST ?dryRun=1 (or { "dryRun": true, ... }) → does all reads + matching
// and returns the PLAN (payloads) without creating/editing anything.
//
// Every step is recorded via _runlog for the execution viewer.

const newRun = require("./_runlog");
const jobber = require("./_jobber");
const { isPublished } = require("./_workflow-config");

const JVER = process.env.JOBBER_QUOTE_GRAPHQL_VERSION || "2025-04-16";
const ARC_TOKEN = process.env.ARCSITE_PROJECTS_TOKEN || "AzFBI6k_NxtkOAo1TGAwmA";
const ARC_GENERIC_OWNER = process.env.ARCSITE_GENERIC_OWNER || "arcsite@alwaysgreenturfaz.com";
const SPECIAL_ASSESSORS = (process.env.ARCSITE_SHARED_ASSESSORS || "cameron,melvin,nolan").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const LANDLINE_ERR = "Landline numbers cannot receive text messages";

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = []; for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return {}; }
}

const clean = (v) => (v == null ? "" : String(v).replace(/\r?\n/g, " ").trim());

async function jobberGql(at, query, variables) {
  const r = await fetch("https://api.getjobber.com/api/graphql", {
    method: "POST", headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json", "X-JOBBER-GRAPHQL-VERSION": JVER },
    body: JSON.stringify({ query, variables }),
  });
  const d = await r.json().catch(() => ({}));
  if (d.errors) throw new Error(`Jobber gql: ${JSON.stringify(d.errors).slice(0, 250)}`);
  return d.data;
}
async function arcsite(method, path, body) {
  const r = await fetch(`https://api.arcsite.com/v1${path}`, {
    method, headers: { Authorization: `Bearer ${ARC_TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`ArcSite ${method} ${path} ${r.status}: ${JSON.stringify(d).slice(0, 180)}`);
  return d;
}

// GHL tz labels → IANA
function mapTz(tz) {
  const t = clean(tz);
  if (!t) return "America/Phoenix";
  if (/arizona/i.test(t)) return "America/Phoenix";
  return t;
}
// "2026-03-05T09:30:00" (+ optional minutes) → { date:"YYYY-MM-DD", time:"HH:MM:SS" }.
// Naive wall-clock is treated as UTC purely for the arithmetic; the timezone is
// carried separately in the Jobber schedule, so the wall-clock values are preserved.
function wallclock(iso, addMin = 0) {
  const s = clean(iso); if (!s) return null;
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + "Z");
  if (isNaN(d.getTime())) return null;
  if (addMin) d.setUTCMinutes(d.getUTCMinutes() + addMin);
  return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 19) };
}
function normalizeTags(raw) {
  if (raw == null) return [];
  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === "string") {
    const s = raw.trim();
    if (s.startsWith("[")) { try { arr = JSON.parse(s); } catch { arr = s.split(/[,|\n]/); } }
    else arr = s.split(/[,|\n]/);
  }
  const seen = new Set(), out = [];
  for (const t of arr) { const v = clean(t); const k = v.toLowerCase(); if (v && !seen.has(k)) { seen.add(k); out.push(v); } }
  return out;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  const raw = await readBody(req);
  const b = raw.body && typeof raw.body === "object" ? raw.body : raw; // accept {body:{...}} or the body directly
  const dryRun = (req.query && req.query.dryRun === "1") || raw.dryRun === true || b.dryRun === true;

  const run = newRun("ghl-appointment", b); // log the full body so a failed run can be replayed
  const out = { dryRun, plan: {} };
  try {
    if (!dryRun && !(await isPublished("ghl-appointment"))) { run.info("Workflow unpublished — skipped", {}); await run.finish("skipped", "Workflow is unpublished"); res.status(200).json({ ok: true, skipped: "unpublished" }); return; }

    const cal = b.calendar || {};
    const email = clean(b.email);
    if (!email) throw new Error("no email on webhook body");

    // Request title: "{city} - {full_name} - {contact_source} - LD MM/DD/YYYY"
    const requestTitle = await run.step("Build request title", { city: b.city, full_name: b.full_name, source: b.contact_source }, async () => {
      let ld = "";
      const d = new Date(clean(b.date_created));
      if (!isNaN(d.getTime())) ld = `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;
      return `${clean(b.city)} - ${clean(b.full_name)} - ${clean(b.contact_source)} - LD ${ld}`;
    });

    // Appointment schedule (timezone-safe)
    const tz = mapTz(cal.selectedTimezone);
    const startAt = wallclock(cal.startTime, 0);
    const endAt = wallclock(cal.endTime, 30); // n8n adds 30 min to the end time
    if (!startAt || !endAt) throw new Error("calendar.startTime / endTime missing or invalid");
    const schedule = { notifyTeam: true, startAt: { ...startAt, timezone: tz }, endAt: { ...endAt, timezone: tz } };
    const instructions = clean(cal.notes);
    out.plan.schedule = schedule;
    out.plan.requestTitle = requestTitle;

    const at = await run.step("Jobber auth", {}, () => jobber.accessToken());

    // 1) Search client by email
    const found = await run.step("Search client in Jobber", { email }, async () => {
      const d = await jobberGql(at, `query($s:String!){ clients(searchTerm:$s){ nodes { id name emails{ id address primary } phones{ id friendly primary } billingAddress{ street city province postalCode country } clientProperties(first:1){ nodes{ id } } requests(first:7){ nodes{ id requestStatus createdAt assessment{ id assignedUsers(first:1){ nodes{ id email{ raw } } } } } } } } }`, { s: email });
      return (d.clients && d.clients.nodes && d.clients.nodes[0]) || null;
    });
    const exists = !!found;
    out.plan.clientAction = exists ? "update" : "create";

    // 2) Match assigned user by email → team member id + name (for ArcSite owner routing)
    const assignedEmail = clean((b.user && b.user.email) || "").toLowerCase();
    const assignee = await run.step("Match assigned user in Jobber", { assignedEmail }, async () => {
      if (!assignedEmail) return null;
      const d = await jobberGql(at, `query{ users(filter:{status:ACTIVATED}, first:500){ nodes{ id name{ full } email{ raw } } } }`, {});
      const u = (d.users && d.users.nodes || []).find((x) => clean(x.email && x.email.raw).toLowerCase() === assignedEmail);
      return u ? { id: u.id, name: u.name && u.name.full, email: u.email && u.email.raw } : null;
    });
    const teamIds = assignee && assignee.id ? [assignee.id] : [];
    out.plan.assignee = assignee;

    const tags = normalizeTags(b.tags);
    const billingAddress = { street1: clean(b.address1), city: clean(b.city), province: clean(b.state), country: clean(b.country || "US"), postalCode: clean(b.postal_code) };
    const addr = { street: clean(b.address1), city: clean(b.city), state: clean(b.state) || "AZ", zip_code: clean(b.postal_code) };

    // ---- DRY RUN: report the plan without writing ----
    if (dryRun) {
      out.plan.tags = tags;
      out.plan.billingAddress = billingAddress;
      const sameDayReq = exists ? (found.requests?.nodes || []).find((r) => clean(r.createdAt).slice(0, 10) === startAt.date) : null;
      out.plan.requestAction = exists && sameDayReq ? (sameDayReq.assessment && sameDayReq.assessment.id ? "reuse request → edit assessment" : "reuse request → create assessment") : "create request + assessment";
      const assessorName = clean(assignee && assignee.name).toLowerCase();
      const shared = SPECIAL_ASSESSORS.some((s) => assessorName.includes(s));
      out.plan.arcsite = { action: exists ? "search → update or create" : "create", owner: shared || !assignee ? ARC_GENERIC_OWNER : assignee.email, name: `${clean(found?.name || b.full_name)}-${addr.street},${addr.city}` };
      await run.finish("dry_run", `DRY RUN — ${out.plan.clientAction} client "${b.full_name}", ${out.plan.requestAction}`);
      res.status(200).json({ ok: true, ...out }); return;
    }

    // ================= LIVE =================
    let clientId, clientName, clientPhoneFriendly, propertyId;

    if (exists) {
      clientId = found.id; clientName = found.name;
      clientPhoneFriendly = (found.phones && found.phones[0] && found.phones[0].friendly) || clean(b.phone);
      // 1a) Update client
      await run.step("Update client", { clientId }, async () => {
        const emailsToEdit = found.emails && found.emails[0] ? [{ id: found.emails[0].id, description: "MAIN", address: email, primary: true }] : undefined;
        const input = { firstName: clean(b.first_name), lastName: clean(b.last_name), billingAddress };
        if (emailsToEdit) input.emailsToEdit = emailsToEdit;
        const d = await jobberGql(at, `mutation($clientId:EncodedId!,$input:ClientEditInput!){ clientEdit(clientId:$clientId,input:$input){ client{ id name } userErrors{ message path } } }`, { clientId, input });
        if (d.clientEdit?.userErrors?.length) throw new Error(`clientEdit: ${JSON.stringify(d.clientEdit.userErrors)}`);
        clientName = d.clientEdit.client.name || clientName; return d.clientEdit.client;
      });
      // 1b) Tags
      if (tags.length) await run.step("Add tags", { tags }, () => jobberGql(at, `mutation($clientId:EncodedId!,$tags:[String!]!){ clientEdit(clientId:$clientId,input:{tagsToAdd:$tags}){ client{ id } userErrors{ message path } } }`, { clientId, tags }));
      // 1c) Property — edit existing or create
      const existingProp = found.clientProperties && found.clientProperties.nodes && found.clientProperties.nodes[0];
      if (existingProp) {
        propertyId = await run.step("Update property", { propertyId: existingProp.id }, async () => {
          const d = await jobberGql(at, `mutation($propertyId:EncodedId!,$address:AddressAttributes!){ propertyEdit(propertyId:$propertyId,input:{address:$address}){ property{ id } userErrors{ message path } } }`, { propertyId: existingProp.id, address: billingAddress });
          if (d.propertyEdit?.userErrors?.length) throw new Error(`propertyEdit: ${JSON.stringify(d.propertyEdit.userErrors)}`);
          return d.propertyEdit.property.id;
        });
      } else {
        propertyId = await run.step("Create property", { clientId }, async () => {
          const d = await jobberGql(at, `mutation($clientId:EncodedId!,$address:AddressAttributes!){ propertyCreate(clientId:$clientId,input:{properties:[{address:$address}]}){ properties{ id } userErrors{ message path } } }`, { clientId, address: billingAddress });
          if (d.propertyCreate?.userErrors?.length) throw new Error(`propertyCreate: ${JSON.stringify(d.propertyCreate.userErrors)}`);
          return d.propertyCreate.properties[0].id;
        });
      }
    } else {
      // 1a) Create client (with SMS phone); on landline error, recreate without phone
      const created = await run.step("Create client", { email }, async () => {
        const withPhone = { firstName: clean(b.first_name), lastName: clean(b.last_name), emails: [{ description: "MAIN", primary: true, address: email }], phones: clean(b.phone) ? [{ description: "MAIN", number: clean(b.phone), primary: true, smsAllowed: true }] : undefined, billingAddress };
        const mut = `mutation($input:ClientCreateInput!){ clientCreate(input:$input){ client{ id name phones{ friendly } } userErrors{ message path } } }`;
        let d = await jobberGql(at, mut, { input: withPhone });
        const errs = d.clientCreate?.userErrors || [];
        if (errs.length && errs.some((e) => (e.message || "").includes(LANDLINE_ERR))) {
          const noPhone = { ...withPhone }; delete noPhone.phones;
          d = await jobberGql(at, mut, { input: noPhone });
        }
        if (d.clientCreate?.userErrors?.length) throw new Error(`clientCreate: ${JSON.stringify(d.clientCreate.userErrors)}`);
        return d.clientCreate.client;
      });
      clientId = created.id; clientName = created.name || clean(b.full_name);
      clientPhoneFriendly = (created.phones && created.phones[0] && created.phones[0].friendly) || clean(b.phone);
      // 1b) Tags
      if (tags.length) await run.step("Add tags", { tags }, () => jobberGql(at, `mutation($clientId:EncodedId!,$tags:[String!]!){ clientEdit(clientId:$clientId,input:{tagsToAdd:$tags}){ client{ id } userErrors{ message path } } }`, { clientId, tags }));
      // 1c) Property
      propertyId = await run.step("Create property", { clientId }, async () => {
        const d = await jobberGql(at, `mutation($clientId:EncodedId!,$address:AddressAttributes!){ propertyCreate(clientId:$clientId,input:{properties:[{address:$address}]}){ properties{ id } userErrors{ message path } } }`, { clientId, address: billingAddress });
        if (d.propertyCreate?.userErrors?.length) throw new Error(`propertyCreate: ${JSON.stringify(d.propertyCreate.userErrors)}`);
        return d.propertyCreate.properties[0].id;
      });
    }

    // 2) Request + assessment. Schedule with the matched assessor assigned.
    const apptSchedule = { ...schedule, ...(teamIds.length ? { teamMemberIdsToAssign: teamIds } : {}) };
    const sameDayReq = exists ? (found.requests?.nodes || []).find((r) => clean(r.createdAt).slice(0, 10) === startAt.date) : null;
    let requestId, assessmentId;
    if (sameDayReq) {
      requestId = sameDayReq.id;
      await run.step("Edit request title", { requestId, title: requestTitle }, () => jobberGql(at, `mutation($requestId:EncodedId!,$title:String!){ requestEdit(requestId:$requestId,input:{title:$title}){ request{ id title } userErrors{ message path } } }`, { requestId, title: requestTitle }));
      if (sameDayReq.assessment && sameDayReq.assessment.id) {
        assessmentId = sameDayReq.assessment.id;
        await run.step("Edit assessment", { assessmentId }, () => jobberGql(at, `mutation($assessmentId:EncodedId!,$input:AssessmentEditInput!){ assessmentEdit(assessmentId:$assessmentId,input:$input){ assessment{ id } userErrors{ message path } } }`, { assessmentId, input: { instructions, schedule: apptSchedule } }));
      } else {
        assessmentId = await run.step("Create assessment", { requestId }, async () => {
          const d = await jobberGql(at, `mutation($requestId:EncodedId!,$input:AssessmentCreateInput!){ assessmentCreate(requestId:$requestId,input:$input){ assessment{ id } userErrors{ message path } } }`, { requestId, input: { instructions, schedule: apptSchedule } });
          if (d.assessmentCreate?.userErrors?.length) throw new Error(`assessmentCreate: ${JSON.stringify(d.assessmentCreate.userErrors)}`);
          return d.assessmentCreate.assessment.id;
        });
      }
    } else {
      const created = await run.step("Create request + assessment", { clientId, propertyId, title: requestTitle, assign: teamIds }, async () => {
        const d = await jobberGql(at, `mutation($input:RequestCreateInput!){ requestCreate(input:$input){ request{ id title assessment{ id } } userErrors{ message path } } }`, { input: { clientId, propertyId, title: requestTitle, assessment: { instructions, schedule: apptSchedule } } });
        if (d.requestCreate?.userErrors?.length) throw new Error(`requestCreate: ${JSON.stringify(d.requestCreate.userErrors)}`);
        return d.requestCreate.request;
      });
      requestId = created.id; assessmentId = created.assessment && created.assessment.id;
    }

    // 3) ArcSite project (owner routing; one project)
    const assessorName = clean(assignee && assignee.name).toLowerCase();
    const shared = SPECIAL_ASSESSORS.some((s) => assessorName.includes(s));
    const owner = shared || !assignee ? ARC_GENERIC_OWNER : assignee.email;
    const projectName = `${clean(clientName || b.full_name)}-${addr.street},${addr.city}`;
    const arcBody = { name: projectName, owner, customer: { name: clean(clientName || b.full_name), phone: clean(clientPhoneFriendly), email, address: addr } };
    const arcResult = await run.step("ArcSite project", { name: projectName, owner, mode: exists ? "search+upsert" : "create" }, async () => {
      if (exists) {
        // /projects/search returns a bare JSON array of matches
        const s = await arcsite("POST", "/projects/search", { project_name: projectName }).catch(() => null);
        const list = Array.isArray(s) ? s : (s && (s.projects || s.data)) || [];
        const m = list.find((p) => clean(p.name) === projectName) || list[0];
        if (m && m.id) {
          const patch = { name: projectName, owner, operator: owner, sales_rep: { email: (assignee && assignee.email) || owner }, customer: { address: addr }, work_site_address: addr };
          return { updated: true, id: m.id, project: await arcsite("PATCH", `/projects/${m.id}`, patch) };
        }
      }
      return { created: true, project: await arcsite("POST", "/projects", arcBody) };
    });
    out.arcsite = arcResult;

    await run.finish("success", `${exists ? "Updated" : "Created"} Jobber client "${clientName}", request ${requestId}${sameDayReq ? " (reused)" : ""}; ArcSite ${arcResult.updated ? "updated" : "created"}`);
    res.status(200).json({ ok: true, clientId, requestId, assessmentId, arcsite: arcResult.updated ? "updated" : "created" });
  } catch (e) {
    await run.finish("error", String(e.message || e));
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
