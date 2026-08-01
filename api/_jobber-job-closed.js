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
    const qboInv = await log.step("Create QBO invoice", { customerRef: project.Id, lines: lines.length, computed, jobberTotal, jobberInvoice: inv.invoiceNumber }, async () =>
      // The memo names the Jobber invoice, so a later run can tell this one is
      // already mirrored instead of copying it again.
      (await qbo.apiPost(qat, rlm, "invoice", { CustomerRef: { value: project.Id }, Line: lines, PrivateNote: `Jobber invoice #${inv.invoiceNumber}` })).Invoice);

    // 3) Mirror any deposit Jobber allocated, so both invoices show the same balance.
    const applied = money((inv.amounts || {}).depositAmount);
    let qboPayment = null;
    if (applied > 0) {
      qboPayment = await log.step("Apply deposit to QBO invoice", { amount: applied, invoiceId: qboInv.Id, customerRef: project.Id }, () =>
        qbo.createPayment(qat, rlm, { customerId: project.Id, amount: applied, invoiceId: qboInv.Id }));
    }

    const balance = money((inv.amounts || {}).invoiceBalance);
    await log.finish("success",
      `Job #${job.jobNumber} → Jobber invoice #${inv.invoiceNumber} ($${jobberTotal}) + QBO invoice #${qboInv.DocNumber} for ${name}` +
      (applied > 0 ? ` — $${applied} deposit applied, $${balance} due` : ""));
    return { ok: true, jobNumber: job.jobNumber, jobberInvoice: inv.invoiceNumber, qboInvoice: qboInv.DocNumber, total: jobberTotal, depositApplied: applied, balanceDue: balance, qboPaymentId: qboPayment && qboPayment.Id, clientName: name };
  } catch (e) { await log.finish("error", String(e.message || e)); throw e; }
}

module.exports = { run };
