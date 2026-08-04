// Jobber INVOICE_CREATE → create the matching QBO invoice on the customer's
// project. Find-or-creates the QBO customer/project if the Job step was missed.
const newRun = require("./_runlog");
const jobber = require("./_jobber");
const qbo = require("./_qbo");
const { isPublished } = require("./_workflow-config");
const { ensureCustomerProject, customerFields, jobberGql } = require("./_jobber-job");

const DEFAULT_ITEM = process.env.QBO_DEFAULT_ITEM || "";
const DISCOUNT_ITEM = process.env.QBO_DISCOUNT_ITEM || "13";
const FEE_ITEM = process.env.QBO_FEE_ITEM || "96";
const clean = (v) => (v == null ? "" : String(v).trim());
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const money = (n) => Number(num(n, 0).toFixed(2));

const INVOICE_QUERY = `query($id:EncodedId!){ invoice(id:$id){ id invoiceNumber subject invoiceStatus
  client{ id name firstName lastName companyName emails{ address } billingAddress{ street city province postalCode country } }
  billingAddress{ street city province postalCode country }
  lineItems{ nodes{ name description quantity unitPrice totalPrice } }
  jobs{ nodes{ id title jobNumber property{ address{ street1 street2 city province postalCode country } } } }
  amounts{ subtotal discountAmount taxAmount depositAmount paymentsTotal invoiceBalance total } } }`;

// Map a Jobber invoice line item → a QBO SalesItemLine.
function toQboLine(li) {
  const name = clean(li.name) || clean(li.description);
  const qty = num(li.quantity, 1);
  const unit = num(li.unitPrice, 0);
  const amount = Number((li.totalPrice != null ? num(li.totalPrice) : qty * unit).toFixed(2));
  const low = name.toLowerCase();
  let itemId = DEFAULT_ITEM;
  if (low.includes("discount")) itemId = DISCOUNT_ITEM;
  else if (low.includes("processing fee")) itemId = FEE_ITEM;
  const detail = { Qty: qty, UnitPrice: unit };
  if (itemId) detail.ItemRef = { value: itemId };
  return { DetailType: "SalesItemLineDetail", Description: name, Amount: amount, SalesItemLineDetail: detail };
}

// Jobber invoice → QBO lines, including the invoice-level discount and the
// processing-fee tax (Jobber carries both outside the line items), so the QBO
// total equals the Jobber total.
function buildQboLines(inv) {
  const lines = ((inv.lineItems && inv.lineItems.nodes) || []).map(toQboLine);
  const a = inv.amounts || {};
  const discount = money(a.discountAmount);
  const tax = money(a.taxAmount);
  if (discount > 0) {
    lines.push({ DetailType: "SalesItemLineDetail", Description: "Discount", Amount: -discount,
      SalesItemLineDetail: { Qty: 1, UnitPrice: -discount, ItemRef: { value: DISCOUNT_ITEM } } });
  }
  if (tax > 0) {
    lines.push({ DetailType: "SalesItemLineDetail", Description: "Processing Fee", Amount: tax,
      SalesItemLineDetail: { Qty: 1, UnitPrice: tax, ItemRef: { value: FEE_ITEM } } });
  }
  const computed = money(lines.reduce((s, l) => s + num(l.Amount), 0));
  return { lines, computed, jobberTotal: money(a.total) };
}

// Mirror an existing Jobber invoice into QBO: find-or-create the customer and
// project, then create the invoice from its line items. Used by the payment
// workflow to rebuild the QBO side for a client that only ever existed in
// Jobber. Re-firing is safe: the memo carries the Jobber invoice number, so an
// invoice already mirrored is returned instead of copied again.
async function mirrorToQbo(log, { at, qat, rlm, invoiceId }) {
  const inv = await log.step("Fetch Jobber invoice", { invoiceId }, async () => {
    const d = await jobberGql(at, INVOICE_QUERY, { id: invoiceId });
    if (!d.invoice) throw new Error("invoice not found in Jobber");
    return d.invoice;
  });
  const property = inv.jobs && inv.jobs.nodes && inv.jobs.nodes[0] && inv.jobs.nodes[0].property;
  const { name } = customerFields(inv.client, property);
  if (!name) throw new Error("invoice has no client name");

  const { lines, computed, jobberTotal } = buildQboLines(inv);
  if (!lines.length) throw new Error(`Jobber invoice #${inv.invoiceNumber} has no line items`);
  if (!DEFAULT_ITEM && lines.some((l) => !l.SalesItemLineDetail.ItemRef)) throw new Error("QBO_DEFAULT_ITEM not set — general invoice lines need a QBO item");

  const { customer, project } = await ensureCustomerProject(log, qat, rlm, inv.client, property);
  const memo = `Jobber invoice #${inv.invoiceNumber}`;
  const existing = ((await qbo.query(qat, rlm, `SELECT * FROM Invoice WHERE CustomerRef = '${project.Id}'`)).Invoice || [])
    .find((i) => String(i.PrivateNote || "").includes(memo));
  if (existing) {
    log.info("Jobber invoice already mirrored", { qboInvoice: existing.DocNumber, balance: Number(existing.Balance) });
    return { inv, name, customer, project, qboInv: existing, qboNumber: existing.DocNumber || null, existed: true, jobberTotal, computed };
  }
  if (computed !== jobberTotal) log.info("Total mismatch — check mapping", { computed, jobberTotal });
  const made = await log.step("Create QBO invoice", { customerRef: project.Id, lines: lines.length, computed, jobberTotal, jobberInvoice: inv.invoiceNumber }, () =>
    qbo.createInvoice(qat, rlm, { customerId: project.Id, lines, docNumber: inv.invoiceNumber, memo }));
  if (made.requested && !made.matched) log.info("QBO numbered the invoice itself", { requested: made.requested, qbo: made.docNumber, duplicate: made.duplicate });
  return { inv, name, customer, project, qboInv: made.invoice, qboNumber: made.docNumber, existed: false, jobberTotal, computed };
}

async function run({ invoiceId, dryRun }) {
  const log = newRun("jobber-invoice", { invoiceId, dryRun });
  try {
    if (!dryRun && !(await isPublished("jobber-invoice"))) { log.info("Unpublished — skipped", {}); await log.finish("skipped", "Workflow is unpublished"); return { ok: true, skipped: "unpublished" }; }
    if (!invoiceId) throw new Error("no invoice id");
    const at = await log.step("Jobber auth", {}, () => jobber.accessToken());
    const inv = await log.step("Fetch Jobber invoice", { invoiceId }, async () => {
      const d = await jobberGql(at, `query($id:EncodedId!){ invoice(id:$id){ id invoiceNumber subject client{ id name firstName lastName companyName emails{ address } billingAddress{ street city province postalCode country } } billingAddress{ street city province postalCode country } lineItems{ nodes{ name description quantity unitPrice totalPrice } } jobs{ nodes{ id title jobNumber property{ address{ street1 street2 city province postalCode country } } } } amounts{ total } } }`, { id: invoiceId });
      if (!d.invoice) throw new Error("invoice not found");
      return d.invoice;
    });
    const property = inv.jobs && inv.jobs.nodes && inv.jobs.nodes[0] && inv.jobs.nodes[0].property;
    const { name } = customerFields(inv.client, property);
    if (!name) throw new Error("invoice has no client name");
    const liNodes = (inv.lineItems && inv.lineItems.nodes) || [];
    const lines = liNodes.map(toQboLine);

    if (dryRun) {
      await log.finish("dry_run", `DRY RUN — would create QBO invoice for "${name}" (Jobber #${inv.invoiceNumber}), ${lines.length} line(s), total ${inv.amounts && inv.amounts.total}`);
      return { ok: true, dryRun: true, clientName: name, jobberInvoice: inv.invoiceNumber, lines, needsDefaultItem: !DEFAULT_ITEM };
    }
    if (!lines.length) throw new Error("invoice has no line items");
    if (!DEFAULT_ITEM && lines.some((l) => !l.SalesItemLineDetail.ItemRef)) throw new Error("QBO_DEFAULT_ITEM not set — general invoice lines need a QBO item");

    const qat = await log.step("QBO auth", {}, () => qbo.accessToken());
    const rlm = await qbo.realm();
    const { project } = await ensureCustomerProject(log, qat, rlm, inv.client, property); // create-on-the-fly
    const made = await log.step("Create QBO invoice", { customerRef: project.Id, lines: lines.length, jobberInvoice: inv.invoiceNumber }, () =>
      qbo.createInvoice(qat, rlm, { customerId: project.Id, lines, docNumber: inv.invoiceNumber, memo: `Jobber invoice #${inv.invoiceNumber}` }));
    if (made.requested && !made.matched) log.info("QBO numbered the invoice itself", { requested: made.requested, qbo: made.docNumber, duplicate: made.duplicate });
    const qboNumber = made.docNumber || "(unnumbered)";
    await log.finish("success", `QBO invoice #${qboNumber} for ${name} (Jobber invoice #${inv.invoiceNumber})`);
    return { ok: true, qboInvoice: qboNumber, qboInvoiceMatchesJobber: made.matched, jobberInvoice: inv.invoiceNumber, clientName: name };
  } catch (e) { await log.finish("error", String(e.message || e)); throw e; }
}

module.exports = { run, toQboLine, buildQboLines, mirrorToQbo, INVOICE_QUERY };
