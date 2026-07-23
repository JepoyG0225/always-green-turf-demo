// GHL assignee update → reassign the Jobber assessment + re-owner the ArcSite project.
// Ported from the n8n "Update GHL-Jober-Arcsite" workflow.
//
// Fires when a contact's assigned rep changes in GHL. Gated on: the contact has
// an appointment, the client exists in Jobber, and the new assignee matches an
// activated Jobber user. Then:
//   - Jobber: assessmentEdit → teamMemberIdsToAssign = [newUser]
//   - ArcSite: search project by client name → archive it → create a new project
//     ("{client}-{city}") owned by the generic account (if the rep is in the
//     shared list) or by the rep's own email.
//
// Dry run: POST ?dryRun=1 → reports the plan without writing.

const newRun = require("./_runlog");
const jobber = require("./_jobber");
const { isPublished } = require("./_workflow-config");

const JVER = process.env.JOBBER_QUOTE_GRAPHQL_VERSION || "2025-04-16";
const GHL_TOKEN = process.env.GHL_API_TOKEN || "pit-9ce64e63-b959-40a9-a58d-9cd6e7fcc32e";
const ARC_TOKEN = process.env.ARCSITE_PROJECTS_TOKEN || "AzFBI6k_NxtkOAo1TGAwmA";
const ARC_GENERIC_OWNER = process.env.ARCSITE_GENERIC_OWNER || "arcsite@alwaysgreenturfaz.com";
const SHARED = (process.env.ARCSITE_REASSIGN_SHARED || "micky,cameron,melvin,amanda,diana").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

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

const CLIENT_QUERY = `query($s:String!){ clients(searchTerm:$s){ nodes { id name phones{ friendly } emails{ address } billingAddress{ street city province postalCode country } requests(first:7){ nodes{ id createdAt assessment{ id } } } } } }`;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  const raw = await readBody(req);
  const b = raw.body && typeof raw.body === "object" ? raw.body : raw;
  const dryRun = (req.query && req.query.dryRun === "1") || raw.dryRun === true || b.dryRun === true;

  const run = newRun("ghl-reassign", { dryRun, contact: b.full_name, email: b.email, newAssignee: b.user && b.user.email });
  const plan = { dryRun };
  try {
    if (!dryRun && !(await isPublished("ghl-reassign"))) { run.info("Workflow unpublished — skipped", {}); await run.finish("skipped", "Workflow is unpublished"); res.status(200).json({ ok: true, skipped: "unpublished" }); return; }

    const contactId = clean(b.contact_id || b.contactId || (b.contact && b.contact.id));
    const email = clean(b.email);
    const assignedEmail = clean(b.user && b.user.email).toLowerCase();
    if (!contactId) throw new Error("no contact_id on webhook body");
    if (!email) throw new Error("no email on webhook body");

    // Gate 1: contact has an appointment
    const hasAppt = await run.step("Get GHL appointments", { contactId }, async () => {
      const r = await fetch(`https://services.leadconnectorhq.com/contacts/${encodeURIComponent(contactId)}/appointments`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${GHL_TOKEN}`, Version: "2021-04-15" },
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`GHL ${r.status}: ${JSON.stringify(d).slice(0, 150)}`);
      const events = d.events || d.appointments || (Array.isArray(d) ? d : []);
      return { count: events.length, has: events.length > 0 };
    });
    plan.hasAppointment = hasAppt.has;
    // Gates hard-stop a LIVE run; a dry run continues so it can report the full plan.
    if (!hasAppt.has && !dryRun) { await run.finish("skipped", "Contact has no appointment — nothing to reassign"); res.status(200).json({ ok: true, skipped: "no-appointment" }); return; }

    const at = await run.step("Jobber auth", {}, () => jobber.accessToken());

    // Gate 2: client exists in Jobber
    const client = await run.step("Search client in Jobber", { email }, async () => {
      const d = await jobberGql(at, CLIENT_QUERY, { s: email });
      return (d.clients && d.clients.nodes && d.clients.nodes[0]) || null;
    });
    plan.clientExists = !!client;
    if (!client && !dryRun) { await run.finish("skipped", `No Jobber client for ${email}`); res.status(200).json({ ok: true, skipped: "no-client" }); return; }

    // Gate 3: new assignee matches an activated Jobber user
    const user = await run.step("Match assigned user in Jobber", { assignedEmail }, async () => {
      if (!assignedEmail) return null;
      const d = await jobberGql(at, `query{ users(filter:{status:ACTIVATED}, first:500){ nodes{ id name{ full } email{ raw } } } }`, {});
      const u = (d.users && d.users.nodes || []).find((x) => clean(x.email && x.email.raw).toLowerCase() === assignedEmail);
      return u ? { id: u.id, name: u.name && u.name.full, email: u.email && u.email.raw } : null;
    });
    plan.matchedUser = user;
    if (!user && !dryRun) { await run.finish("skipped", `Assignee ${assignedEmail} is not an activated Jobber user`); res.status(200).json({ ok: true, skipped: "no-user-match" }); return; }

    const firstReq = client && client.requests && client.requests.nodes && client.requests.nodes[0];
    const assessmentId = (firstReq && firstReq.assessment && firstReq.assessment.id) || null;
    plan.assessmentId = assessmentId;

    // ArcSite owner routing (only computable once we have the client + matched user)
    const shared = SHARED.some((s) => assignedEmail.includes(s));
    const owner = user ? (shared ? ARC_GENERIC_OWNER : user.email) : null;
    const projectName = client ? `${clean(client.name)}-${clean(client.billingAddress && client.billingAddress.city)}` : null;
    if (client) plan.arcsite = { search: clean(client.name), archiveThenCreate: projectName, owner };

    if (dryRun) {
      const gate = !hasAppt.has ? "no-appointment" : !client ? "no-client" : !user ? "no-user-match" : "would-run";
      await run.finish("dry_run", `DRY RUN — gate:${gate}${client && user ? `; reassign ${assessmentId ? "→ " + user.name : "(no assessment)"}; ArcSite archive+create "${projectName}" owner ${owner}` : ""}`);
      res.status(200).json({ ok: true, gate, plan }); return;
    }

    // ===== LIVE =====
    // 1) Reassign the assessment to the new user
    if (assessmentId) {
      await run.step("Reassign assessment", { assessmentId, userId: user.id, user: user.name }, async () => {
        const d = await jobberGql(at, `mutation($assessmentId:EncodedId!,$userId:EncodedId!){ assessmentEdit(assessmentId:$assessmentId,input:{schedule:{teamMemberIdsToAssign:[$userId]}}){ assessment{ id assignedUsers(last:5){ nodes{ id email{ raw } } } } userErrors{ message path } } }`, { assessmentId, userId: user.id });
        if (d.assessmentEdit?.userErrors?.length) throw new Error(`assessmentEdit: ${JSON.stringify(d.assessmentEdit.userErrors)}`);
        return d.assessmentEdit.assessment;
      });
    } else {
      run.info("No assessment on the client's first request — skipped reassignment", {});
    }

    // 2) ArcSite: search by client name → archive matches → create new project
    const arc = await run.step("ArcSite archive + recreate", { search: clean(client.name), newName: projectName, owner }, async () => {
      const s = await arcsite("POST", "/projects/search", { project_name: clean(client.name) }).catch(() => null);
      const list = Array.isArray(s) ? s : (s && (s.projects || s.data)) || [];
      const archived = [];
      for (const p of list) {
        if (p && p.id && !p.archived) { await arcsite("POST", `/projects/${p.id}/archive`).catch(() => {}); archived.push(p.id); }
      }
      const ba = client.billingAddress || {};
      const created = await arcsite("POST", "/projects", {
        name: projectName, owner,
        customer: {
          name: clean(client.name),
          phone: clean(client.phones && client.phones[0] && client.phones[0].friendly),
          email: clean((client.emails && client.emails[0] && client.emails[0].address) || email),
          address: { street: clean(ba.street), city: clean(ba.city), state: "AZ", zip_code: clean(ba.postalCode) },
        },
      });
      return { archived, createdId: created && created.id };
    });
    plan.arcsite.result = arc;

    await run.finish("success", `Reassigned to ${user.name}; ArcSite archived ${arc.archived.length}, created ${projectName}`);
    res.status(200).json({ ok: true, reassignedTo: user.name, assessmentId, arcsite: arc });
  } catch (e) {
    await run.finish("error", String(e.message || e));
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
