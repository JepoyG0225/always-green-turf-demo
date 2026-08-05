// ArcSite "proposal.sent" webhook → Jobber quote.
// (QBO customer/project/invoice are now created from Jobber "Job created" /
// "Invoice created" webhooks instead of here.) Every step is recorded via _runlog.

const newRun = require("./_runlog");
const jobber = require("./_jobber");
const { isPublished } = require("./_workflow-config");

const ARCSITE_TOKEN = process.env.ARCSITE_TOKEN || "";
const JVER = process.env.JOBBER_QUOTE_GRAPHQL_VERSION || "2025-04-16";

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = []; for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return {}; }
}
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const pct = (n) => `${Math.round(n)}%`;
const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();

// Edit distance, capped — used to spot a misspelt customer rather than creating
// a near-duplicate ("Christie Friendly" when "Christy Friendly" already exists).
function editDistance(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Same surname and a first name within a couple of characters is a typo, not a
// new customer. Anything looser would risk merging two real people.
function closeMatch(want, nodes) {
  const w = normName(want).split(" ");
  if (w.length < 2) return null;
  const wLast = w[w.length - 1], wFirst = w[0];
  if (wFirst.length < 4) return null; // too short for a typo to be distinguishable
  return nodes.find((c) => {
    const p = normName(c.name).split(" ");
    if (p.length < 2 || p[0].length < 4) return false;
    return p[p.length - 1] === wLast && editDistance(p[0], wFirst) <= 2;
  }) || null;
}

// ArcSite titles read "Proposal for <name>-<street>,<city>" (or just "-<city>").
// Everything this business quotes is Arizona, so the state is assumed.
function propertyFromTitle(title, customerName) {
  let rest = String(title || "").replace(/^\s*proposal for\s*/i, "");
  const n = normName(customerName);
  if (normName(rest).startsWith(n)) rest = rest.slice(customerName.length);
  // Require the separator: without it the remainder is some other title text,
  // not an address, and guessing would file the quote at a made-up location.
  if (!/^\s*[-–—]/.test(rest)) return null;
  rest = rest.replace(/^\s*[-–—]\s*/, "").trim();
  if (!rest) return null;
  const parts = rest.split(",").map((s) => s.trim()).filter(Boolean);
  const city = parts.length > 1 ? parts[parts.length - 1] : parts[0];
  const street1 = parts.length > 1 ? parts.slice(0, -1).join(", ") : "";
  if (!city) return null;
  return { street1: street1 || undefined, city, province: "AZ", country: "United States" };
}

// ArcSite marks a change order in the proposal title:
//   "Proposal for Jodi Pullen-2518 E Thornton Court,Gilbert - Change Order #1"
// Ordinary proposals never contain the phrase, so the title is a far more
// reliable signal than trying to infer one from repeat proposals on a project.
const CHANGE_ORDER = /\bchange\s*-?\s*order(?:\s*#\s*(\d+))?/i;

// A change order restates the whole scope, not just the addition — the Jodi
// Pullen example went $5,213.85 → $5,697.13 with a full line-item set — so the
// quote's lines are REPLACED. Appending would bill the original work twice.
async function replaceQuoteLineItems(at, quoteId, existingIds, lineItems) {
  if (existingIds.length) {
    const d = await jobberGql(at,
      `mutation($quoteId: EncodedId!, $ids: [EncodedId!]!){ quoteDeleteLineItems(quoteId: $quoteId, lineItemIds: $ids){ quote { id } userErrors { message path } } }`,
      { quoteId, ids: existingIds });
    if (d.quoteDeleteLineItems?.userErrors?.length) throw new Error(`quoteDeleteLineItems: ${JSON.stringify(d.quoteDeleteLineItems.userErrors)}`);
  }
  const d = await jobberGql(at,
    `mutation($quoteId: EncodedId!, $lineItems: [QuoteCreateLineItemAttributes!]!){ quoteCreateLineItems(quoteId: $quoteId, lineItems: $lineItems){ quote { id quoteNumber amounts { total } } userErrors { message path } } }`,
    { quoteId, lineItems });
  if (d.quoteCreateLineItems?.userErrors?.length) throw new Error(`quoteCreateLineItems: ${JSON.stringify(d.quoteCreateLineItems.userErrors)}`);
  return d.quoteCreateLineItems?.quote;
}

async function jobberGql(at, query, variables) {
  const r = await fetch("https://api.getjobber.com/api/graphql", {
    method: "POST", headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json", "X-JOBBER-GRAPHQL-VERSION": JVER },
    body: JSON.stringify({ query, variables }),
  });
  const d = await r.json().catch(() => ({}));
  if (d.errors) throw new Error(`Jobber gql: ${JSON.stringify(d.errors).slice(0, 250)}`);
  return d.data;
}

// Port of the "Set JSON" node: ArcSite line_items + markup + discounts + fee → Jobber lineItems.
function buildLineItems(arc) {
  const src = Array.isArray(arc) ? arc[0] : arc;
  const raw = Array.isArray(src?.line_items) ? src.line_items : [];
  let subtotal = 0;
  const lineItems = raw.map((li) => {
    const qty = num(li.quantity, 1);
    // `total` is the line amount and is what ArcSite's own subtotal is built
    // from. `price` agrees with it on ordinary items, but on tiered/price-part
    // items (Paver Delivery, Base Delivery, some paver borders) it is the tier
    // rate rather than the line amount — reading it first overcharged those
    // lines. Custom items carry no `price` at all, hence the fallback.
    const total = num(li.total ?? li.price, 0);
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

    // 3) Find the Jobber client, creating it when this is genuinely a new
    //    customer. Two things in the ArcSite data must NOT be created:
    //    a drawing left with the rep's own name in the customer field, and a
    //    misspelling of somebody already in Jobber.
    const client = await run.step("Find or create Jobber client", { customerName, title: data.name }, async () => {
      const d = await jobberGql(jat, `query($s: String!){ clients(searchTerm: $s, first: 20){ nodes { id name firstName lastName companyName isArchived clientProperties(first:1){ nodes { id } } } } }`, { s: customerName });
      const nodes = (d.clients?.nodes || []).filter((c) => !c.isArchived);

      const exact = nodes.find((c) => normName(c.name) === normName(customerName));
      if (exact) return { ...exact, matchedBy: "exact" };

      // A near-miss is either a typo or a different person with the same
      // surname, and the two are indistinguishable from here. Creating would
      // duplicate a real client; assuming would quote the wrong one — so stop
      // and name the suspect rather than guessing.
      const near = closeMatch(customerName, nodes);
      if (near) {
        throw new Error(`"${customerName}" isn't in Jobber but closely matches existing client "${near.name}". Not creating a possible duplicate — fix the name in ArcSite and re-send, or create the client in Jobber first.`);
      }

      // The customer field sometimes holds the rep who drew the proposal.
      // Creating that would put an employee in the client list.
      const repName = String(data.sales_representative || "").trim();
      if (repName && normName(repName) === normName(customerName)) {
        throw new Error(`ArcSite customer_name "${customerName}" is the sales rep — the drawing has no customer set. Fix it in ArcSite and re-send.`);
      }
      const users = await jobberGql(jat, `query { users(first: 100){ nodes { name { full } } } }`, {});
      if ((users.users?.nodes || []).some((u) => normName(u.name?.full) === normName(customerName))) {
        throw new Error(`ArcSite customer_name "${customerName}" matches a Jobber user (staff), not a customer. Fix the drawing in ArcSite and re-send.`);
      }

      // Same shape the GHL appointment flow uses: create the client, then add
      // the property separately (ArcSite gives us no customer email or phone —
      // contact_email on the webhook is the rep's).
      const parts = String(customerName).trim().split(/\s+/);
      const firstName = parts[0] || customerName;
      const lastName = parts.slice(1).join(" ") || "";
      const address = propertyFromTitle(data.name, customerName);
      const input = { firstName, lastName, ...(address ? { billingAddress: address } : {}) };
      const c = await jobberGql(jat,
        `mutation($input: ClientCreateInput!){ clientCreate(input: $input){ client { id name } userErrors { message path } } }`,
        { input });
      if (c.clientCreate?.userErrors?.length) throw new Error(`clientCreate: ${JSON.stringify(c.clientCreate.userErrors)}`);
      const made = c.clientCreate?.client;
      if (!made) throw new Error("clientCreate returned no client");

      let props = [];
      if (address) {
        const p = await jobberGql(jat,
          `mutation($clientId: EncodedId!, $address: AddressAttributes!){ propertyCreate(clientId: $clientId, input:{ properties:[{ address: $address }] }){ properties { id } userErrors { message path } } }`,
          { clientId: made.id, address });
        if (p.propertyCreate?.userErrors?.length) run.info("Property not created", { errors: p.propertyCreate.userErrors });
        props = (p.propertyCreate?.properties || []).map((x) => ({ id: x.id }));
      }
      run.info("Created Jobber client", { name: made.name, address: address || "none parsed from title" });
      return { ...made, clientProperties: { nodes: props }, matchedBy: "created" };
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

    // 5a) A change order revises the client's latest quote instead of adding
    //     another one. Only the line items and title change — the quote keeps
    //     its number, its deposit and its place in Jobber.
    const changeOrder = CHANGE_ORDER.exec(String(data.name || ""));
    let revised = null;
    if (changeOrder) {
      revised = await run.step("Revise latest quote (change order)", { client: client.name, changeOrder: changeOrder[1] || "yes", lines: lineItems.length }, async () => {
        const d = await jobberGql(jat,
          `query($id: EncodedId!){ client(id: $id){ quotes(first: 25){ nodes { id quoteNumber quoteStatus title createdAt jobberWebUri amounts { total } lineItems(first: 100){ nodes { id } } } } } }`,
          { id: client.id });
        const quotes = (d.client?.quotes?.nodes || [])
          .slice()
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        const target = quotes[0];
        if (!target) return { revised: false, reason: "client has no existing quote" };

        const existingIds = (target.lineItems?.nodes || []).map((n) => n.id);
        const before = target.amounts?.total;
        const after = await replaceQuoteLineItems(jat, target.id, existingIds, lineItems);
        // Carry the change-order wording onto the quote so it's visible in Jobber.
        await jobberGql(jat,
          `mutation($quoteId: EncodedId!, $attributes: QuoteEditAttributes!){ quoteEdit(quoteId: $quoteId, attributes: $attributes){ quote { id } userErrors { message path } } }`,
          { quoteId: target.id, attributes: { title: data.name } });
        return {
          revised: true, quoteId: target.id, quoteNumber: target.quoteNumber, status: target.quoteStatus,
          previousTitle: target.title, replacedLines: existingIds.length, newLines: lineItems.length,
          totalBefore: before, totalAfter: after?.amounts?.total, jobberWebUri: target.jobberWebUri,
        };
      });
      if (revised.revised) {
        await run.finish("success", `Change order ${changeOrder[1] ? "#" + changeOrder[1] + " " : ""}applied to quote ${revised.quoteNumber} for ${customerName} — $${revised.totalBefore} → $${revised.totalAfter}`);
        res.status(200).json({ ok: true, changeOrder: true, quote: revised.quoteNumber, quoteUri: revised.jobberWebUri, totalBefore: revised.totalBefore, totalAfter: revised.totalAfter });
        return;
      }
      run.info("Change order with nothing to revise — creating a quote instead", { reason: revised.reason });
    }

    // 5) Create Jobber quote (assigned to the matched salesperson when found)
    const quote = await run.step("Create Quote in Jobber", { clientId: client.id, propertyId, title, salespersonId, lineItems }, async () => {
      // A brand-new client with no parseable address has no property yet —
      // send the key only when we have one rather than an explicit null.
      const attributes = { clientId: client.id, title: data.name || title, lineItems };
      if (propertyId) attributes.propertyId = propertyId;
      if (salespersonId) attributes.salespersonId = salespersonId;
      const d = await jobberGql(jat,
        `mutation($attributes: QuoteCreateAttributes!){ quoteCreate(attributes:$attributes){ quote { id quoteNumber quoteStatus jobberWebUri salesperson { id name { full } } } userErrors { message path } } }`,
        { attributes });
      if (d.quoteCreate?.userErrors?.length) throw new Error(`quoteCreate: ${JSON.stringify(d.quoteCreate.userErrors)}`);
      return d.quoteCreate.quote;
    });

    // QBO is handled separately now: the Jobber "Job created" webhook creates the
    // QBO customer + project, and "Invoice created" creates the QBO invoice.
    await run.finish("success", `Quote ${quote.quoteNumber} for ${customerName}${client.matchedBy === "created" ? " (new Jobber client created)" : ""}`);
    res.status(200).json({ ok: true, quote: quote.quoteNumber, quoteUri: quote.jobberWebUri, client: { id: client.id, name: client.name, matchedBy: client.matchedBy } });
  } catch (e) {
    await run.finish("error", String(e.message || e));
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
