// Jobber JOB_CREATE → create the QBO customer + project (sub-customer).
// The invoice is created later by _jobber-invoice on INVOICE_CREATE.
const newRun = require("./_runlog");
const jobber = require("./_jobber");
const qbo = require("./_qbo");
const { isPublished } = require("./_workflow-config");
const JVER = process.env.JOBBER_QUOTE_GRAPHQL_VERSION || "2025-04-16";
const clean = (v) => (v == null ? "" : String(v).trim());

async function jobberGql(at, query, variables) {
  const r = await fetch("https://api.getjobber.com/api/graphql", {
    method: "POST", headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json", "X-JOBBER-GRAPHQL-VERSION": JVER },
    body: JSON.stringify({ query, variables }),
  });
  const d = await r.json().catch(() => ({}));
  if (d.errors) throw new Error(`Jobber gql: ${JSON.stringify(d.errors).slice(0, 250)}`);
  return d.data;
}

// clientName + billing address for a Jobber client + property (shared with invoice flow)
function customerFields(client, property) {
  const c = client || {};
  const name = clean(c.name) || [clean(c.firstName), clean(c.lastName)].filter(Boolean).join(" ") || clean(c.companyName);
  const email = (c.emails && c.emails[0] && clean(c.emails[0].address)) || "";
  const a = (property && property.address) || (c.billingAddress) || {};
  const extra = {};
  if (email) extra.PrimaryEmailAddr = { Address: email };
  if (clean(a.street1) || clean(a.street)) extra.BillAddr = { Line1: clean(a.street1 || a.street), City: clean(a.city), CountrySubDivisionCode: clean(a.province), PostalCode: clean(a.postalCode), Country: clean(a.country) };
  return { name, email, extra };
}

// Find (or create) the QBO customer + same-named project sub-customer.
async function ensureCustomerProject(log, qat, rlm, client, property) {
  const { name, extra } = customerFields(client, property);
  if (!name) throw new Error("client has no name");
  const customer = await log.step("Create QBO customer", { name }, () => qbo.findOrCreateCustomer(qat, rlm, name, extra));
  const project = await log.step("Create QBO project", { name, parent: customer.Id }, () => qbo.findOrCreateCustomer(qat, rlm, name, { Job: true, ParentRef: { value: customer.Id } }));
  return { customer, project, name };
}

async function run({ jobId, dryRun }) {
  const log = newRun("jobber-job", { jobId, dryRun });
  try {
    if (!dryRun && !(await isPublished("jobber-job"))) { log.info("Unpublished — skipped", {}); await log.finish("skipped", "Workflow is unpublished"); return { ok: true, skipped: "unpublished" }; }
    if (!jobId) throw new Error("no job id");
    const at = await log.step("Jobber auth", {}, () => jobber.accessToken());
    const job = await log.step("Fetch Jobber job", { jobId }, async () => {
      const d = await jobberGql(at, `query($id:EncodedId!){ job(id:$id){ id jobNumber title client{ id name firstName lastName companyName emails{ address } } property{ address{ street1 street2 city province postalCode country } } } }`, { id: jobId });
      if (!d.job) throw new Error("job not found");
      return d.job;
    });
    const { name } = customerFields(job.client, job.property);
    if (!name) throw new Error("job has no client name");

    if (dryRun) { await log.finish("dry_run", `DRY RUN — would create QBO customer + project "${name}" (job #${job.jobNumber})`); return { ok: true, dryRun: true, clientName: name, jobNumber: job.jobNumber }; }

    const qat = await log.step("QBO auth", {}, () => qbo.accessToken());
    const rlm = await qbo.realm();
    const { customer, project } = await ensureCustomerProject(log, qat, rlm, job.client, job.property);
    await log.finish("success", `QBO customer ${customer.Id} + project ${project.Id} for ${name} (job #${job.jobNumber})`);
    return { ok: true, customerId: customer.Id, projectId: project.Id, clientName: name };
  } catch (e) { await log.finish("error", String(e.message || e)); throw e; }
}

module.exports = { run, ensureCustomerProject, customerFields, jobberGql };
