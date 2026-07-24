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
    const qboInv = await log.step("Create QBO invoice", { customerRef: project.Id, lines: lines.length }, async () => {
      return (await qbo.apiPost(qat, rlm, "invoice", { CustomerRef: { value: project.Id }, Line: lines })).Invoice;
    });
    await log.finish("success", `QBO invoice #${qboInv.DocNumber} for ${name} (Jobber invoice #${inv.invoiceNumber})`);
    return { ok: true, qboInvoice: qboInv.DocNumber, jobberInvoice: inv.invoiceNumber, clientName: name };
  } catch (e) { await log.finish("error", String(e.message || e)); throw e; }
}

module.exports = { run, toQboLine };
