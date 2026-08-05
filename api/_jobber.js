// Jobber helper — token refresh (rotating), GraphQL, payment fetch, HMAC verify.
const crypto = require("crypto");
const { getToken, saveToken } = require("./_integration-tokens");
const CID = process.env.JOBBER_CLIENT_ID, CSEC = process.env.JOBBER_CLIENT_SECRET;
const VER = process.env.JOBBER_API_VERSION || "2023-11-15";
const QUOTE_VER = process.env.JOBBER_QUOTE_GRAPHQL_VERSION || "2025-04-16";

// Jobber rotates the refresh token on every use, so refreshing on each call
// races under concurrent webhooks (loser gets 401). We cache the short-lived
// ACCESS token (valid ~1h) and only refresh when it's near expiry, and recover
// from a race 401 by picking up whatever a concurrent run already produced.
async function readCachedAccess() {
  try {
    const raw = await getToken("jobber_access");
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (c && c.t && c.exp && c.exp - 120 > Math.floor(Date.now() / 1000)) return c.t;
  } catch {}
  return null;
}

async function refreshAccess(recover) {
  const rt = await getToken("jobber");
  if (!rt) throw new Error("Jobber not connected");
  const r = await fetch("https://api.getjobber.com/api/oauth/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: CID, client_secret: CSEC, grant_type: "refresh_token", refresh_token: rt }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) {
    // Rotating-token race: another invocation may have already refreshed.
    if (recover) {
      const cached = await readCachedAccess();
      if (cached) return cached;                                  // winner cached a fresh access token
      const rt2 = await getToken("jobber");
      if (rt2 && rt2 !== rt) return await refreshAccess(false);   // winner saved a new refresh token
    }
    throw new Error(`Jobber refresh ${r.status}: ${JSON.stringify(d).slice(0, 150)}`);
  }
  if (d.refresh_token && d.refresh_token !== rt) await saveToken("jobber", d.refresh_token);
  const exp = Math.floor(Date.now() / 1000) + (Number(d.expires_in) || 3600);
  try { await saveToken("jobber_access", JSON.stringify({ t: d.access_token, exp })); } catch {}
  return d.access_token;
}

async function accessToken() {
  return (await readCachedAccess()) || (await refreshAccess(true));
}

async function gql(at, query, variables) {
  const r = await fetch("https://api.getjobber.com/api/graphql", {
    method: "POST", headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json", "X-JOBBER-GRAPHQL-VERSION": VER },
    body: JSON.stringify({ query, variables }),
  });
  const d = await r.json().catch(() => ({}));
  if (d.errors) throw new Error(`Jobber gql: ${JSON.stringify(d.errors).slice(0, 200)}`);
  return d.data;
}

async function getPayment(at, id) {
  const d = await gql(at,
    `query($id: EncodedId!) {
       paymentRecord(id: $id) {
         id amount entryDate
         allocations(first: 20) { nodes { amount ... on InvoicePaymentRecordAllocation { invoice { id invoiceNumber } } } }
         client {
           id firstName lastName companyName email
           emails { address }
           billingAddress { street city province postalCode country }
           quotes(first: 5) { nodes {
             id quoteNumber quoteStatus depositAmountUnallocated amounts { total }
             property { id }
             jobs(first: 5) { nodes { id jobNumber } }
             lineItems(first: 100) { nodes { id name description quantity unitPrice unitCost taxable } }
           } }
           invoices(first: 20) { nodes { id invoiceNumber invoiceStatus amounts { total invoiceBalance } } }
         }
       }
     }`, { id });
  return d.paymentRecord;
}

// Turn an approved quote into a job, carrying its line items across.
//
// A deposit is normally paid at signing and someone converts the quote by hand
// later; until they do there is no job, so nothing creates the QBO customer or
// project and the money has nowhere to land. Creating the job here closes that
// gap — Jobber's JOB_CREATE webhook then drives the QBO side as usual, and the
// deposit stays held on the quote until the job is closed and invoiced.
async function createJobFromQuote(at, quote, { salespersonId } = {}) {
  const propertyId = quote.property && quote.property.id;
  if (!propertyId) throw new Error(`quote #${quote.quoteNumber} has no property to put the job on`);
  const lineItems = ((quote.lineItems && quote.lineItems.nodes) || []).map((li, i) => ({
    name: li.name || "Item",
    ...(li.description ? { description: li.description } : {}),
    quantity: Number(li.quantity) || 1,
    unitPrice: Number(li.unitPrice) || 0,
    ...(li.unitCost != null ? { unitCost: Number(li.unitCost) } : {}),
    taxable: li.taxable !== false,
    saveToProductsAndServices: false,
    quoteLineItemId: li.id, // keeps the job line tied back to the quote line
    sortOrder: i,
  }));
  const attributes = {
    propertyId,
    quoteId: quote.id,
    // One-off installs: bill the agreed price once the work is done.
    invoicing: { invoicingType: "FIXED_PRICE", invoicingSchedule: "ON_COMPLETION" },
    ...(lineItems.length ? { lineItems } : {}),
    ...(salespersonId ? { salespersonId } : {}),
  };
  // JobCreateAttributes is the newer schema, so pin this call to the same
  // GraphQL version the quote/job workflows use rather than this file's default.
  const r = await fetch("https://api.getjobber.com/api/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json", "X-JOBBER-GRAPHQL-VERSION": QUOTE_VER },
    // jobCreate takes `input`, not `attributes` — unlike quoteCreate/clientCreate.
    body: JSON.stringify({
      query: `mutation($input: JobCreateAttributes!){ jobCreate(input: $input){ job { id jobNumber title } userErrors { message path } } }`,
      variables: { input: attributes },
    }),
  });
  const d0 = await r.json().catch(() => ({}));
  if (d0.errors) throw new Error(`Jobber gql: ${JSON.stringify(d0.errors).slice(0, 250)}`);
  const d = d0.data || {};
  if (d.jobCreate?.userErrors?.length) throw new Error(`jobCreate: ${JSON.stringify(d.jobCreate.userErrors)}`);
  if (!d.jobCreate?.job) throw new Error("jobCreate returned no job");
  return d.jobCreate.job;
}

// Jobber signs webhooks with base64(HMAC-SHA256(rawBody, clientSecret)) in X-Jobber-Hmac-SHA256.
function verifyHmac(rawBody, header) {
  if (!header || !CSEC) return false;
  const digest = crypto.createHmac("sha256", CSEC).update(rawBody, "utf8").digest("base64");
  try { return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(String(header))); } catch { return false; }
}

module.exports = { accessToken, gql, getPayment, createJobFromQuote, verifyHmac };
