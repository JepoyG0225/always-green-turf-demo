// ArcSite "proposal.sent" webhook → Jobber quote (+ PDF note) → QBO customer/project/invoice.
// Ported from the n8n "Arcsite - Jobber Send Quote" workflow. Every step is
// recorded (input/output) via _runlog for the execution-log viewer.

const newRun = require("./_runlog");
const jobber = require("./_jobber");
const qbo = require("./_qbo");
const { isPublished } = require("./_workflow-config");

const ARCSITE_TOKEN = process.env.ARCSITE_TOKEN || "";
const SUPA = process.env.SUPABASE_URL || "https://otgpzpepmurbydcghygb.supabase.co";
const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const JVER = process.env.JOBBER_QUOTE_GRAPHQL_VERSION || "2025-04-16";
const QBO_DISCOUNT_ITEM = process.env.QBO_DISCOUNT_ITEM || "20";
const QBO_FEE_ITEM = process.env.QBO_FEE_ITEM || "22";

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = []; for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return {}; }
}
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const pct = (n) => `${Math.round(n)}%`;

async function jobberGql(at, query, variables) {
  const r = await fetch("https://api.getjobber.com/api/graphql", {
    method: "POST", headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json", "X-JOBBER-GRAPHQL-VERSION": JVER },
    body: JSON.stringify({ query, variables }),
  });
  const d = await r.json().catch(() => ({}));
  if (d.errors) throw new Error(`Jobber gql: ${JSON.stringify(d.errors).slice(0, 250)}`);
  return d.data;
}

async function qboPost(at, rlm, entity, body) {
  const base = qbo.ENV === "production" ? "https://quickbooks.api.intuit.com" : "https://sandbox-quickbooks.api.intuit.com";
  const r = await fetch(`${base}/v3/company/${rlm}/${entity}?minorversion=70`, {
    method: "POST", headers: { Authorization: `Bearer ${at}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`QBO ${entity} ${r.status}: ${JSON.stringify(d).slice(0, 220)}`);
  return d;
}
async function qboQuery(at, rlm, sql) {
  const base = qbo.ENV === "production" ? "https://quickbooks.api.intuit.com" : "https://sandbox-quickbooks.api.intuit.com";
  const r = await fetch(`${base}/v3/company/${rlm}/query?query=${encodeURIComponent(sql)}&minorversion=70`, { headers: { Authorization: `Bearer ${at}`, Accept: "application/json" } });
  const d = await r.json().catch(() => ({})); return (d.QueryResponse) || {};
}
// QBO DisplayName must be unique — reuse if it already exists.
async function findOrCreateCustomer(at, rlm, displayName, extra) {
  const esc = displayName.replace(/'/g, "\\'");
  const existing = (await qboQuery(at, rlm, `SELECT * FROM Customer WHERE DisplayName = '${esc}'${extra?.ParentRef ? "" : ""}`)).Customer;
  if (existing && existing.length) {
    if (extra?.ParentRef) { const sub = existing.find((c) => c.ParentRef?.value === extra.ParentRef.value); if (sub) return sub; }
    else return existing[0];
  }
  return (await qboPost(at, rlm, "customer", { DisplayName: displayName, ...extra })).Customer;
}

// Port of the "Set JSON" node: ArcSite line_items + markup + discounts + fee → Jobber lineItems.
function buildLineItems(arc) {
  const src = Array.isArray(arc) ? arc[0] : arc;
  const raw = Array.isArray(src?.line_items) ? src.line_items : [];
  let subtotal = 0;
  const lineItems = raw.map((li) => {
    const qty = num(li.quantity, 1);
    const total = num(li.price ?? li.total, 0);
    subtotal += total;
    return { name: String(li.name || "Unnamed Item"), quantity: qty, unitPrice: Number((qty > 0 ? total / qty : total).toFixed(2)), saveToProductsAndServices: false };
  });
  const markup = Math.abs(num(src?.markup, 0));
  if (markup > 0 && subtotal > 0) lineItems.push({ name: `Markup (${pct((markup / subtotal) * 100)})`, quantity: 1, unitPrice: Number(markup.toFixed(2)), saveToProductsAndServices: false });
  const discounts = Array.isArray(src?.discounts) ? src.discounts : (num(src?.discount, 0) ? [{ amount: src.discount }] : []);
  const multi = discounts.length > 1;
  discounts.forEach((d, i) => {
    const amount = Math.abs(num(d.amount ?? d.total ?? d.price ?? d, 0));
    if (amount <= 0) return;
    const rate = (d.rate != null || d.percent != null) ? num(d.rate ?? d.percent, 0) : (subtotal > 0 ? (amount / subtotal) * 100 : 0);
    const label = d.name ? `${d.name} (${pct(rate)})` : multi ? `Discount ${i + 1} (${pct(rate)})` : `Discount (${pct(rate)})`;
    lineItems.push({ name: label, quantity: 1, unitPrice: -Number(amount.toFixed(2)), saveToProductsAndServices: false });
  });
  let fee = 0;
  if (Array.isArray(src?.taxes)) { const pf = src.taxes.find((t) => t.name === "Processing Fee"); if (pf) fee = Math.abs(num(pf.total, 0)); }
  if (fee > 0) lineItems.push({ name: "Processing Fee", quantity: 1, unitPrice: Number(fee.toFixed(2)), saveToProductsAndServices: false });
  return { lineItems, title: src?.name || "Automated Quote" };
}

// Port of the "Code in JavaScript" node: Jobber lineItems → QBO invoice Line[].
function toQboLines(lineItems) {
  return lineItems.map((item) => {
    const amount = Number((item.quantity * item.unitPrice).toFixed(2));
    const detail = { Qty: item.quantity, UnitPrice: item.unitPrice };
    if (item.name.toLowerCase().includes("discount")) detail.ItemRef = { value: QBO_DISCOUNT_ITEM };
    else if (item.name === "Processing Fee") detail.ItemRef = { value: QBO_FEE_ITEM };
    return { DetailType: "SalesItemLineDetail", Description: item.name, Amount: amount, SalesItemLineDetail: detail };
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  const body = await readBody(req);
  const data = body.data || {};
  const run = newRun("arcsite-quote", body);
  const customerName = data.customer_name || "";
  const opt = (data.proposal_options && data.proposal_options[0]) || {};

  try {
    if ((body.event && body.event !== "proposal.sent")) { run.info("Ignored event", { event: body.event }); await run.finish("skipped", `Ignored ${body.event}`); res.status(200).json({ ok: true, ignored: body.event }); return; }
    if (!(await isPublished("arcsite-quote"))) { run.info("Workflow unpublished — skipped", {}); await run.finish("skipped", "Workflow is unpublished"); res.status(200).json({ ok: true, skipped: "unpublished" }); return; }
    if (!customerName || !opt.drawing_id) throw new Error("Missing customer_name or drawing_id");

    // 1) ArcSite quote details (line items, markup, discounts, taxes)
    const arc = await run.step("Get Quote Details (ArcSite)", { drawing_id: opt.drawing_id }, async () => {
      const r = await fetch(`https://api.arcsite.com/v1/drawings/${opt.drawing_id}/line_items`, { headers: { Authorization: `Bearer ${ARCSITE_TOKEN}` } });
      if (!r.ok) throw new Error(`ArcSite ${r.status}: ${(await r.text()).slice(0, 150)}`);
      return r.json();
    });

    // 2) Jobber access token
    const jat = await run.step("Get Jobber Auth", {}, () => jobber.accessToken());

    // 3) Search client in Jobber
    const client = await run.step("Search Client in Jobber", { customerName }, async () => {
      const d = await jobberGql(jat, `query($s: String!){ clients(searchTerm: $s){ nodes { id name clientProperties(first:1){ nodes { id } } } } }`, { s: customerName });
      const nodes = d.clients?.nodes || [];
      if (!nodes.length) throw new Error(`No Jobber client found for "${customerName}"`);
      return nodes[0];
    });
    const propertyId = client.clientProperties?.nodes?.[0]?.id || null;

    // 4) Build Jobber quote line items (markup/discounts/fee)
    const { lineItems, title } = await run.step("Build Quote Line Items", arc, async () => buildLineItems(arc));

    // 5) Create Jobber quote
    const quote = await run.step("Create Quote in Jobber", { clientId: client.id, propertyId, title, lineItems }, async () => {
      const d = await jobberGql(jat,
        `mutation($attributes: QuoteCreateAttributes!){ quoteCreate(attributes:$attributes){ quote { id quoteNumber quoteStatus jobberWebUri } userErrors { message path } } }`,
        { attributes: { clientId: client.id, propertyId, title: data.name || title, lineItems } });
      if (d.quoteCreate?.userErrors?.length) throw new Error(`quoteCreate: ${JSON.stringify(d.quoteCreate.userErrors)}`);
      return d.quoteCreate.quote;
    });

    // 6) Download the ArcSite PDF and host it on Supabase Storage
    let publicPdf = null;
    if (opt.pdf_url) {
      const fileName = opt.pdf_url.split("?")[0].split("/").pop();
      await run.step("Host PDF on Supabase", { fileName }, async () => {
        const pr = await fetch(opt.pdf_url); if (!pr.ok) throw new Error(`PDF download ${pr.status}`);
        const buf = Buffer.from(await pr.arrayBuffer());
        const up = await fetch(`${SUPA}/storage/v1/object/quote-pdfs/${fileName}`, { method: "POST", headers: { Authorization: `Bearer ${SKEY}`, apikey: SKEY, "Content-Type": "application/pdf", "x-upsert": "true" }, body: buf });
        if (!up.ok) throw new Error(`storage ${up.status}: ${(await up.text()).slice(0, 150)}`);
        return { bytes: buf.length };
      });
      publicPdf = `${SUPA}/storage/v1/object/public/quote-pdfs/${fileName}`;
      // 7) Attach the PDF link as a quote note
      await run.step("Attach PDF note to Quote", { quoteId: quote.id, publicPdf }, async () => {
        const d = await jobberGql(jat, `mutation($id: EncodedId!, $msg: String!){ quoteCreateNote(quoteId: $id, input:{ message: $msg }){ quote { id } } }`, { id: quote.id, msg: `Drawing Proposal PDF:\n${publicPdf}` });
        return d.quoteCreateNote;
      });
    }

    // 8) QBO customer + project (sub-customer), then invoice
    const at = await run.step("Get QBO Auth", {}, () => qbo.accessToken());
    const rlm = await qbo.realm();
    const customer = await run.step("Create QBO Customer", { DisplayName: client.name }, () => findOrCreateCustomer(at, rlm, client.name));
    const project = await run.step("Create QBO Project", { DisplayName: customerName, parent: customer.Id }, () => findOrCreateCustomer(at, rlm, customerName, { Job: true, ParentRef: { value: customer.Id } }));
    const qboLines = await run.step("Map QBO Invoice Lines", { lineItems }, async () => toQboLines(lineItems));
    const invoice = await run.step("Create QBO Invoice", { CustomerRef: project.Id, lines: qboLines.length }, async () => (await qboPost(at, rlm, "invoice", { CustomerRef: { value: project.Id }, Line: qboLines })).Invoice);

    await run.finish("success", `Quote ${quote.quoteNumber} + QBO invoice #${invoice.DocNumber} for ${customerName}`);
    res.status(200).json({ ok: true, quote: quote.quoteNumber, quoteUri: quote.jobberWebUri, qboInvoice: invoice.DocNumber });
  } catch (e) {
    await run.finish("error", String(e.message || e));
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
