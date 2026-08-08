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

// Read an invoice back after creating it. invoiceCreate returns the invoice as
// it stands at that instant — before Jobber has applied the linked quote's
// discount to it. Mirroring that response into QBO posts the undiscounted
// total, which is what happened to job #5163 (Rodney Phillips): Jobber invoice
// #2905 correctly showed a $1,565.67 discount, QBO did not.
//
// Note the create response was internally consistent without the discount, so
// the existing computed-vs-total check could not catch it. The re-read has to
// be unconditional rather than triggered by a mismatch.
const INVOICE_QUERY = `query($id:EncodedId!){ invoice(id:$id){ id invoiceNumber invoiceStatus
  client{ id name firstName lastName companyName emails{ address } }
  lineItems{ nodes{ name description quantity unitPrice totalPrice } }
  amounts{ subtotal discountAmount taxAmount depositAmount paymentsTotal invoiceBalance total } } }`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Read until two consecutive reads agree on the total, so we mirror a settled
// invoice rather than one mid-update. Falls back to the create response if the
// reads fail — an invoice mirrored imperfectly beats no QBO invoice at all.
async function settledInvoice(at, id, created, log) {
  let prev = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let cur = null;
    try {
      const d = await jobberGql(at, INVOICE_QUERY, { id });
      cur = d.invoice || null;
    } catch (e) {
      log.info("Invoice re-read failed", { attempt, error: String(e.message || e).slice(0, 140) });
    }
    // A failed read retries rather than giving up: bailing here would fall back
    // to the create response, which is the very thing this exists to avoid.
    if (cur && prev && money((prev.amounts || {}).total) === money((cur.amounts || {}).total)) return cur;
    if (cur) prev = cur;
    if (attempt < 3) await sleep(1200);
  }
  return prev || created;
}

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
      return { ok: true, skipped: "nothing-to-invoice", jobNumber: job.jobNumber, existingInvoices: existing, clientName: name };
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

    // 1b) Read the invoice back before mirroring — see settledInvoice above.
    const settled = await log.step("Re-read the Jobber invoice", { invoiceId: inv.id, invoiceNumber: inv.invoiceNumber }, () =>
      settledInvoice(at, inv.id, inv, log));
    const createdDiscount = money((inv.amounts || {}).discountAmount);
    const settledDiscount = money((settled.amounts || {}).discountAmount);
    const createdTotal = money((inv.amounts || {}).total);
    const settledTotal = money((settled.amounts || {}).total);
    if (settledDiscount !== createdDiscount || settledTotal !== createdTotal) {
      log.info("Invoice settled after create — mirroring the settled figures", {
        discountAtCreate: createdDiscount, discountSettled: settledDiscount,
        totalAtCreate: createdTotal, totalSettled: settledTotal,
      });
    }

    // 2) Mirror into QBO (discount + processing fee become explicit lines).
    const { lines, computed, jobberTotal } = buildQboLines(settled);
    if (computed !== jobberTotal) log.info("Total mismatch — check mapping", { computed, jobberTotal });
    const qat = await log.step("QBO auth", {}, () => qbo.accessToken());
    const rlm = await qbo.realm();
    const { project } = await ensureCustomerProject(log, qat, rlm, settled.client || inv.client || job.client, job.property);
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
    const applied = money((settled.amounts || {}).depositAmount);
    let qboPayment = null;
    if (applied > 0) {
      qboPayment = await log.step("Apply deposit to QBO invoice", { amount: applied, invoiceId: qboInv.Id, customerRef: project.Id }, () =>
        qbo.createPayment(qat, rlm, { customerId: project.Id, amount: applied, invoiceId: qboInv.Id }));
    }

    const balance = money((settled.amounts || {}).invoiceBalance);
    await log.finish("success",
      `Job #${job.jobNumber} → Jobber invoice #${inv.invoiceNumber} ($${jobberTotal}) + QBO invoice #${qboNumber} for ${name}` +
      (applied > 0 ? ` — $${applied} deposit applied, $${balance} due` : ""));
    return { ok: true, jobNumber: job.jobNumber, jobberInvoice: inv.invoiceNumber, qboInvoice: qboNumber, qboInvoiceMatchesJobber: made.matched, total: jobberTotal, depositApplied: applied, balanceDue: balance, qboPaymentId: qboPayment && qboPayment.Id, clientName: name };
  } catch (e) { await log.finish("error", String(e.message || e)); throw e; }
}

module.exports = { run, settledInvoice };
