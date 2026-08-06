// Jobber JOB_CLOSED → create the Jobber invoice for that job, then mirror it
// into QBO as an invoice on the customer's project.
//
// Notes on faithfulness:
//  - Jobber applies the processing fee as a TAX RATE (not a line item), and
//    discounts as an invoice-level discountAmount. Both are mirrored into QBO as
//    explicit lines so the QBO total matches the Jobber total exactly.
//  - The tax rate mirrors the originating quote: if the quote carried tax
//    (processing fee), we use the Processing Fee rate, else the No-Fee rate.
const newRun = require("./_runlog");
const jobber = require("./_jobber");
const qbo = require("./_qbo");
const { isPublished } = require("./_workflow-config");
const { ensureCustomerProject, customerFields, jobberGql } = require("./_jobber-job");
const { buildQboLines } = require("./_jobber-invoice");
const { postJobComplete, isPhoto } = require("./_job-complete-slack");

// Marking sent emails the customer — off by default (invoice stays a draft).
const MARK_SENT = process.env.JOBBER_INVOICE_MARK_SENT === "true";
const INVOICE_NET = Number(process.env.JOBBER_INVOICE_NET || 0); // 0 = due on receipt
const TAX_RATE_FEE = process.env.JOBBER_TAX_RATE_PROCESSING_FEE || "Z2lkOi8vSm9iYmVyL1RheFJhdGUvOTY5MDM3";
const TAX_RATE_NONE = process.env.JOBBER_TAX_RATE_NO_FEE || "Z2lkOi8vSm9iYmVyL1RheFJhdGUvOTg1Nzgx";
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const money = (n) => Number(num(n, 0).toFixed(2));

// Arizona doesn't observe DST, so the business day is unambiguous — but a job
// closed at 6pm Phoenix is already "tomorrow" in UTC, and dating the invoice
// off the raw timestamp would push it into the next day (or next month).
const TZ = process.env.BUSINESS_TIMEZONE || "America/Phoenix";
function businessDate(iso) {
  const d = new Date(iso);
  if (!iso || isNaN(d.getTime())) return null;
  // en-CA formats as YYYY-MM-DD, which is what QBO wants.
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

// The completion photos the installer attached to the job's notes, plus the rep
// and customer details for the Slack post.
//
// Asked for in its own query and tolerantly: the notes/attachment shape is the
// part of Jobber's schema I'm least sure of, and a wrong guess here must not
// cost the invoice. Two shapes are tried — attachments hanging off each note,
// and a flat list on the job — and whichever answers is used.
const COMPLETION_QUERIES = [
  `query($id:EncodedId!){ job(id:$id){ jobNumber title
     salesperson { name { full } email { raw } }
     client { name emails { address } phones { friendly } }
     property { address { street1 street2 city province postalCode } }
     notes(first: 50){ nodes { ... on JobNote { id message createdAt
       fileAttachments(first: 25){ nodes { id fileName contentType url } } } } } } }`,
  `query($id:EncodedId!){ job(id:$id){ jobNumber title
     salesperson { name { full } email { raw } }
     client { name emails { address } phones { friendly } }
     property { address { street1 street2 city province postalCode } }
     noteAttachments(first: 50){ nodes { id fileName contentType url } } } }`,
];

async function completionDetails(at, jobId, log) {
  for (const [i, q] of COMPLETION_QUERIES.entries()) {
    try {
      const d = await jobberGql(at, q, { id: jobId });
      const j = d.job;
      if (!j) continue;
      const fromNotes = ((j.notes && j.notes.nodes) || [])
        .flatMap((n) => ((n && n.fileAttachments && n.fileAttachments.nodes) || []));
      const flat = (j.noteAttachments && j.noteAttachments.nodes) || [];
      const files = [...fromNotes, ...flat].filter(Boolean);
      const a = (j.property && j.property.address) || {};
      return {
        job: { jobNumber: j.jobNumber, title: j.title },
        rep: j.salesperson ? { name: j.salesperson.name && j.salesperson.name.full, email: j.salesperson.email && j.salesperson.email.raw } : null,
        client: {
          name: j.client && j.client.name,
          email: j.client && j.client.emails && j.client.emails[0] && j.client.emails[0].address,
          phone: j.client && j.client.phones && j.client.phones[0] && j.client.phones[0].friendly,
        },
        address: [a.street1, a.street2, a.city, a.province, a.postalCode].filter(Boolean).join(", "),
        photos: files.filter(isPhoto).map((f) => ({ fileName: f.fileName, contentType: f.contentType, url: f.url })),
        shape: i,
      };
    } catch (e) { log.info(`Job notes shape ${i} unavailable`, { error: String(e.message || e).slice(0, 160) }); }
  }
  return null;
}

// When the job was marked complete. Asked for separately and tolerantly: if the
// field isn't in this API version the query throws, and an invoice dated by QBO
// is far better than no invoice at all.
async function completedOn(at, jobId, log) {
  for (const field of ["completedAt", "endAt"]) {
    try {
      const d = await jobberGql(at, `query($id:EncodedId!){ job(id:$id){ ${field} } }`, { id: jobId });
      const raw = d.job && d.job[field];
      if (raw) return { date: businessDate(raw), source: field, raw };
    } catch (e) { log.info(`Job.${field} unavailable`, { error: String(e.message || e).slice(0, 120) }); }
  }
  return { date: null, source: null, raw: null };
}

const JOB_QUERY = `query($id:EncodedId!){ job(id:$id){ id jobNumber title jobStatus total invoicedTotal uninvoicedTotal
  client{ id name firstName lastName companyName emails{ address } }
  property{ address{ street1 street2 city province postalCode country } }
  quote{ id quoteNumber taxDetails{ totalTaxAmount }
    depositAmountUnallocated unallocatedDepositRecords(first:20){ nodes{ id amount } } }
  lineItems{ nodes{ id name description quantity unitPrice taxable } }
  invoices(first:5){ nodes{ id invoiceNumber } } } }`;

const INVOICE_CREATE = `mutation($input:InvoiceCreateInput!){ invoiceCreate(input:$input){
  invoice{ id invoiceNumber invoiceStatus
    client{ id name firstName lastName companyName emails{ address } }
    lineItems{ nodes{ name description quantity unitPrice totalPrice } }
    amounts{ subtotal discountAmount taxAmount depositAmount paymentsTotal invoiceBalance total } }
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
    const existing = ((job.invoices && job.invoices.nodes) || []).map((i) => i.invoiceNumber);

    // Guard: already billed (or a re-fired JOB_CLOSED) — never double-invoice.
    if (uninvoiced <= 0) {
      log.info("Nothing to invoice", { uninvoicedTotal: uninvoiced, existingInvoices: existing });
      await log.finish("skipped", `Job #${job.jobNumber} has nothing uninvoiced — no invoice created`);
      return { ok: true, skipped: "nothing-to-invoice", jobNumber: job.jobNumber, existingInvoices: existing };
    }

    // Mirror the quote's processing-fee decision onto the invoice's tax rate.
    const quoteTax = num(job.quote && job.quote.taxDetails && job.quote.taxDetails.totalTaxAmount, 0);
    const taxRateId = quoteTax > 0 ? TAX_RATE_FEE : TAX_RATE_NONE;

    // Deposits the customer already paid against the quote. Passing their ids to
    // invoiceCreate allocates them to this invoice, so the Jobber balance is net
    // of the deposit; we mirror that in QBO as a payment on the new invoice.
    const depositRecords = ((job.quote && job.quote.unallocatedDepositRecords && job.quote.unallocatedDepositRecords.nodes) || []);
    const depositIds = depositRecords.map((d) => d.id);
    const depositTotal = money(depositRecords.reduce((s, d) => s + num(d.amount), 0));
    if (depositTotal > 0) log.info("Applying prior quote deposits", { quote: job.quote.quoteNumber, count: depositIds.length, depositTotal });
    const jobLines = (job.lineItems && job.lineItems.nodes) || [];
    const lineItems = jobLines.map((li) => ({
      name: li.name || "Item",
      ...(li.description ? { description: li.description } : {}),
      quantity: num(li.quantity, 1),
      unitPrice: num(li.unitPrice, 0),
      taxable: li.taxable !== false,
      jobLineItemId: li.id, // links the invoice line back to the job line
    }));
    if (!lineItems.length) throw new Error(`Job #${job.jobNumber} has no line items to invoice`);

    if (dryRun) {
      await log.finish("dry_run", `DRY RUN — would invoice job #${job.jobNumber} (${name}, ${lineItems.length} lines, uninvoiced ${uninvoiced}) with ${quoteTax > 0 ? "Processing Fee" : "No Processing Fee"} rate${depositTotal > 0 ? `, applying $${depositTotal} in prior deposits` : ""}, then post to QBO`);
      return { ok: true, dryRun: true, jobNumber: job.jobNumber, clientName: name, uninvoicedTotal: uninvoiced, lineCount: lineItems.length, quoteTaxAmount: quoteTax, taxRate: quoteTax > 0 ? "Processing Fee" : "No Processing Fee", invoiceNet: INVOICE_NET, markSent: MARK_SENT, existingInvoices: existing, depositTotal, depositCount: depositIds.length, estimatedBalanceDue: money(uninvoiced - depositTotal) };
    }

    // 1) Create the invoice in Jobber.
    const inv = await log.step("Create Jobber invoice", { jobId, lines: lineItems.length, taxRateId, invoiceNet: INVOICE_NET, markSent: MARK_SENT, depositIds, depositTotal }, async () => {
      const input = {
        clientId: job.client.id,
        jobId,
        lineItems,
        dueDetails: { invoiceNet: INVOICE_NET },
        tax: { taxCalculationMethod: "EXCLUSIVE", taxRateId },
        ...(depositIds.length ? { depositIds } : {}),
        ...(MARK_SENT ? { markSent: true } : {}),
      };
      const d = await jobberGql(at, INVOICE_CREATE, { input });
      if (d.invoiceCreate?.userErrors?.length) throw new Error(`invoiceCreate: ${JSON.stringify(d.invoiceCreate.userErrors)}`);
      if (!d.invoiceCreate?.invoice) throw new Error("invoiceCreate returned no invoice");
      return d.invoiceCreate.invoice;
    });

    // 2) Mirror into QBO (discount + processing fee become explicit lines).
    const { lines, computed, jobberTotal } = buildQboLines(inv);
    if (computed !== jobberTotal) log.info("Total mismatch — check mapping", { computed, jobberTotal });
    const qat = await log.step("QBO auth", {}, () => qbo.accessToken());
    const rlm = await qbo.realm();
    const { project } = await ensureCustomerProject(log, qat, rlm, inv.client || job.client, job.property);
    // Same number on both sides, and the memo names the Jobber invoice so a
    // later run can tell this one is already mirrored instead of copying it.
    // Date the invoice the day the job was marked complete, not the day this
    // ran — a re-run days later must not move the revenue into another month.
    const completed = await completedOn(at, jobId, log);
    if (completed.date) log.info("Dating the QBO invoice from job completion", { completedAt: completed.raw, source: completed.source, txnDate: completed.date, timezone: TZ });
    else log.info("No completion date on the job — QBO will date the invoice today", {});

    const made = await log.step("Create QBO invoice", { customerRef: project.Id, lines: lines.length, computed, jobberTotal, jobberInvoice: inv.invoiceNumber, txnDate: completed.date }, () =>
      qbo.createInvoice(qat, rlm, { customerId: project.Id, lines, docNumber: inv.invoiceNumber, memo: `Jobber invoice #${inv.invoiceNumber}`, txnDate: completed.date }));
    const qboInv = made.invoice;
    const qboNumber = made.docNumber || "(unnumbered)";
    if (made.duplicate) log.info("QBO already had that invoice number — QBO numbered it instead", { jobber: inv.invoiceNumber, qbo: made.docNumber });
    else if (made.requested && !made.matched) log.info("QBO ignored the requested number — enable Custom transaction numbers in QBO to keep them matched", { requested: made.requested, qbo: made.docNumber });

    // 3) Mirror any deposit Jobber allocated, so both invoices show the same balance.
    const applied = money((inv.amounts || {}).depositAmount);
    let qboPayment = null;
    if (applied > 0) {
      qboPayment = await log.step("Apply deposit to QBO invoice", { amount: applied, invoiceId: qboInv.Id, customerRef: project.Id }, () =>
        qbo.createPayment(qat, rlm, { customerId: project.Id, amount: applied, invoiceId: qboInv.Id }));
    }

    // Slack #job-complete — the installer's photos, the customer and the rep.
    // Wrapped: the invoice is done and must not be undone by a Slack problem.
    let slackPost = { posted: false, reason: "not attempted" };
    try {
      const details = await completionDetails(at, jobId, log);
      if (!details) slackPost = { posted: false, reason: "could not read the job's notes" };
      else {
        slackPost = await log.step("Post to Slack #job-complete", { photos: details.photos.length, rep: details.rep && details.rep.email }, () =>
          postJobComplete(log, { job: details.job, client: details.client, address: details.address, rep: details.rep, photos: details.photos }));
      }
    } catch (e) {
      slackPost = { posted: false, reason: String(e.message || e) };
      log.info("Slack job-complete post failed", { error: slackPost.reason });
    }

    const balance = money((inv.amounts || {}).invoiceBalance);
    await log.finish("success",
      `Job #${job.jobNumber} → Jobber invoice #${inv.invoiceNumber} ($${jobberTotal}) + QBO invoice #${qboNumber} for ${name}` +
      (applied > 0 ? ` — $${applied} deposit applied, $${balance} due` : "") +
      (slackPost.posted ? ` · Slack: ${slackPost.photos} photo(s)` : ""));
    return { ok: true, jobNumber: job.jobNumber, jobberInvoice: inv.invoiceNumber, qboInvoice: qboNumber, qboInvoiceMatchesJobber: made.matched, total: jobberTotal, depositApplied: applied, balanceDue: balance, qboPaymentId: qboPayment && qboPayment.Id, clientName: name, slack: slackPost };
  } catch (e) { await log.finish("error", String(e.message || e)); throw e; }
}

module.exports = { run };
