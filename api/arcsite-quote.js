// ArcSite "proposal.sent" webhook → Jobber quote (+ PDF note) → QBO customer/project/invoice.
// Ported from the n8n "Arcsite - Jobber Send Quote" workflow. Every step is
// recorded (input/output) via _runlog for the execution-log viewer.

const newRun = require("./_runlog");
const jobber = require("./_jobber");
const qbo = require("./_qbo");
const { isPublished } = require("./_workflow-config");
const { put } = require("@vercel/blob");

const ARCSITE_TOKEN = process.env.ARCSITE_TOKEN || "";
const JVER = process.env.JOBBER_QUOTE_GRAPHQL_VERSION || "2025-04-16";
// PDFs are hosted on Vercel Blob and served under our own domain via /quote-pdfs/.
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || "https://always-green-turf-demo.vercel.app").replace(/\/$/, "");
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

    // 3b) Match the ArcSite sales rep to a Jobber user (salesperson).
    //     Email is authoritative — the ArcSite display name often differs from
    //     the Jobber user's name (e.g. "Aaron Karkhoff" → Jobber "Aaron K").
    const repEmail = String(data.contact_email || "").trim().toLowerCase();
    const repName = String(data.sales_representative || "").trim().toLowerCase();
    let salespersonId = null;
    if (repEmail || repName) {
      salespersonId = await run.step("Match Salesperson in Jobber", { repEmail, repName }, async () => {
        const d = await jobberGql(jat, `query { users(first: 100){ nodes { id name { full } email { raw } status } } }`, {});
        const users = d.users?.nodes || [];
        const active = (u) => u.status === "ACTIVATED";
        const emailMatch = repEmail ? users.find((u) => (u.email?.raw || "").toLowerCase() === repEmail) : null;
        const nameMatch = !emailMatch && repName
          ? (users.find((u) => (u.name?.full || "").toLowerCase() === repName && active(u)) || users.find((u) => (u.name?.full || "").toLowerCase() === repName))
          : null;
        const m = emailMatch || nameMatch;
        return m ? { id: m.id, name: m.name?.full, email: m.email?.raw, matchedBy: emailMatch ? "email" : "name" } : { id: null, reason: "no matching Jobber user" };
      });
      salespersonId = salespersonId && salespersonId.id ? salespersonId.id : null;
    }

    // 4) Build Jobber quote line items (markup/discounts/fee)
    const { lineItems, title } = await run.step("Build Quote Line Items", arc, async () => buildLineItems(arc));

    // 5) Create Jobber quote (assigned to the matched salesperson when found)
    const quote = await run.step("Create Quote in Jobber", { clientId: client.id, propertyId, title, salespersonId, lineItems }, async () => {
      const attributes = { clientId: client.id, propertyId, title: data.name || title, lineItems };
      if (salespersonId) attributes.salespersonId = salespersonId;
      const d = await jobberGql(jat,
        `mutation($attributes: QuoteCreateAttributes!){ quoteCreate(attributes:$attributes){ quote { id quoteNumber quoteStatus jobberWebUri salesperson { id name { full } } } userErrors { message path } } }`,
        { attributes });
      if (d.quoteCreate?.userErrors?.length) throw new Error(`quoteCreate: ${JSON.stringify(d.quoteCreate.userErrors)}`);
      return d.quoteCreate.quote;
    });

    // 6) Download the ArcSite PDF and host it on Vercel Blob (served under our domain)
    let publicPdf = null;
    if (opt.pdf_url) {
      const fileName = (opt.pdf_url.split("?")[0].split("/").pop() || "quote.pdf").replace(/[^a-zA-Z0-9._-]/g, "");
      await run.step("Host PDF on Vercel Blob", { fileName }, async () => {
        const pr = await fetch(opt.pdf_url); if (!pr.ok) throw new Error(`PDF download ${pr.status}`);
        const buf = Buffer.from(await pr.arrayBuffer());
        if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error("BLOB_READ_WRITE_TOKEN not set — create a Vercel Blob store");
        const blob = await put(`quote-pdfs/${fileName}`, buf, {
          access: "public", addRandomSuffix: false, allowOverwrite: true,
          contentType: "application/pdf", token: process.env.BLOB_READ_WRITE_TOKEN,
        });
        return { bytes: buf.length, blobUrl: blob.url };
      });
      publicPdf = `${PUBLIC_BASE}/quote-pdfs/${fileName}`;
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
