// Jobber JOB_CLOSED → create the Jobber invoice for that job, then mirror it
// into QBO as an invoice on the customer's project.
//
// Replaces the old INVOICE_CREATE-triggered QBO invoice flow: closing a job in
// Jobber doesn't auto-invoice, so we create the invoice here and then post it
// to QuickBooks in the same run.
const newRun = require("./_runlog");
const jobber = require("./_jobber");
const qbo = require("./_qbo");
const { isPublished } = require("./_workflow-config");
const { ensureCustomerProject, customerFields, jobberGql } = require("./_jobber-job");
const { toQboLine } = require("./_jobber-invoice");

// Marking the invoice as sent emails the customer — off by default so the
// invoice is created as a draft for review. Set JOBBER_INVOICE_MARK_SENT=true
// to have Jobber send it automatically.
const MARK_SENT = process.env.JOBBER_INVOICE_MARK_SENT === "true";
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

const JOB_QUERY = `query($id:EncodedId!){ job(id:$id){ id jobNumber title jobStatus total invoicedTotal uninvoicedTotal
  client{ id name firstName lastName companyName emails{ address } }
  property{ address{ street1 street2 city province postalCode country } }
  invoices(first:5){ nodes{ id invoiceNumber } } } }`;

const INVOICE_CREATE = `mutation($input:InvoiceCreateInput!){ invoiceCreate(input:$input){
  invoice{ id invoiceNumber invoiceStatus
    client{ id name firstName lastName companyName emails{ address } }
    lineItems{ nodes{ name description quantity unitPrice totalPrice } }
    amounts{ total } }
  userErrors{ message path } } }`;

async function run({ jobId, dryRun }) {
  const log = newRun("jobber-job-closed", { jobId, dryRun });
  try {
    if (!dryRun && !(await isPublished("jobber-job-closed"))) { log.info("Unpublished — skipped", {}); await log.finish("skipped", "Workflow is unpublished"); return { ok: true, skipped: "unpublished" }; }
    if (!jobId) throw new Error("no job id");

    const at = await log.step("Jobber auth", {}, () => jobber.accessToken());
    const job = await log.step("Fetch Jobber job", { jobId }, async () => {
      const d = await jobberGql(at, JOB_QUERY, { id: jobId });
      if (!d.job) throw new Error("job not found");
      return d.job;
    });
    const { name } = customerFields(job.client, job.property);
    const uninvoiced = num(job.uninvoicedTotal, 0);
    const existingInvoices = (job.invoices && job.invoices.nodes) || [];

    // Guard: nothing left to bill (already invoiced, or a re-fired JOB_CLOSED).
    if (uninvoiced <= 0) {
      log.info("Nothing to invoice", { uninvoicedTotal: uninvoiced, existingInvoices: existingInvoices.map((i) => i.invoiceNumber) });
      await log.finish("skipped", `Job #${job.jobNumber} has nothing uninvoiced — no invoice created`);
      return { ok: true, skipped: "nothing-to-invoice", jobNumber: job.jobNumber };
    }

    if (dryRun) {
      await log.finish("dry_run", `DRY RUN — would invoice job #${job.jobNumber} (${name}, uninvoiced ${uninvoiced}) then create the QBO invoice`);
      return { ok: true, dryRun: true, jobNumber: job.jobNumber, clientName: name, uninvoicedTotal: uninvoiced, existingInvoices: existingInvoices.map((i) => i.invoiceNumber), markSent: MARK_SENT };
    }

    // 1) Create the invoice in Jobber for this job.
    const inv = await log.step("Create Jobber invoice", { jobId, markSent: MARK_SENT }, async () => {
      const input = { jobId, ...(MARK_SENT ? { markSent: true } : {}) };
      const d = await jobberGql(at, INVOICE_CREATE, { input });
      if (d.invoiceCreate?.userErrors?.length) throw new Error(`invoiceCreate: ${JSON.stringify(d.invoiceCreate.userErrors)}`);
      if (!d.invoiceCreate?.invoice) throw new Error("invoiceCreate returned no invoice");
      return d.invoiceCreate.invoice;
    });

    // 2) Mirror it into QBO on the customer's project.
    const lines = ((inv.lineItems && inv.lineItems.nodes) || []).map(toQboLine);
    if (!lines.length) throw new Error(`Jobber invoice #${inv.invoiceNumber} has no line items to post to QBO`);
    const qat = await log.step("QBO auth", {}, () => qbo.accessToken());
    const rlm = await qbo.realm();
    const { project } = await ensureCustomerProject(log, qat, rlm, inv.client || job.client, job.property);
    const qboInv = await log.step("Create QBO invoice", { customerRef: project.Id, lines: lines.length, jobberInvoice: inv.invoiceNumber }, async () =>
      (await qbo.apiPost(qat, rlm, "invoice", { CustomerRef: { value: project.Id }, Line: lines })).Invoice);

    await log.finish("success", `Job #${job.jobNumber} → Jobber invoice #${inv.invoiceNumber} + QBO invoice #${qboInv.DocNumber} for ${name}`);
    return { ok: true, jobNumber: job.jobNumber, jobberInvoice: inv.invoiceNumber, qboInvoice: qboInv.DocNumber, clientName: name };
  } catch (e) { await log.finish("error", String(e.message || e)); throw e; }
}

module.exports = { run };
