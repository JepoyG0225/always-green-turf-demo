// QuickBooks Online helper — token refresh (rotating), query, apply payment.
const { getToken, saveToken } = require("./_integration-tokens");
const CID = process.env.QBO_CLIENT_ID, CSEC = process.env.QBO_CLIENT_SECRET;
const ENV = process.env.QBO_ENV || "sandbox";
const BASE = ENV === "production" ? "https://quickbooks.api.intuit.com" : "https://sandbox-quickbooks.api.intuit.com";
const esc = (s) => String(s).replace(/'/g, "\\'");

async function realm() { return (await getToken("qbo_realm")) || process.env.QBO_REALM_ID || ""; }

async function accessToken() {
  const rt = await getToken("qbo");
  if (!rt) throw new Error("QBO not connected");
  const basic = Buffer.from(`${CID}:${CSEC}`).toString("base64");
  const r = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
    method: "POST", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error(`QBO refresh ${r.status}: ${JSON.stringify(d).slice(0, 150)}`);
  if (d.refresh_token && d.refresh_token !== rt) await saveToken("qbo", d.refresh_token);
  return d.access_token;
}

async function query(at, rlm, sql) {
  const r = await fetch(`${BASE}/v3/company/${rlm}/query?query=${encodeURIComponent(sql)}&minorversion=70`, { headers: { Authorization: `Bearer ${at}`, Accept: "application/json" } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`QBO query ${r.status}: ${JSON.stringify(d).slice(0, 150)}`);
  return d.QueryResponse || {};
}

// Returns every customer (and sub-customer/job) matching the email or name —
// QBO often puts invoices on a job (e.g. "Jodi Pullen:Jodi Pullen") rather than
// the parent, so we gather them all and let invoice-matching decide.
async function findCustomers(at, rlm, { email, name, company }) {
  const byId = new Map();
  const add = (arr) => (arr || []).forEach((c) => byId.set(c.Id, c));
  if (email) add((await query(at, rlm, `SELECT * FROM Customer WHERE PrimaryEmailAddr = '${esc(email)}'`)).Customer);
  const dn = company || name;
  if (dn) {
    add((await query(at, rlm, `SELECT * FROM Customer WHERE DisplayName = '${esc(dn)}'`)).Customer);
    add((await query(at, rlm, `SELECT * FROM Customer WHERE FullyQualifiedName LIKE '%${esc(dn)}%'`)).Customer);
  }
  return [...byId.values()];
}

// Open invoices across the given customer ids (parent + any jobs).
async function openInvoices(at, rlm, customerIds) {
  const ids = (Array.isArray(customerIds) ? customerIds : [customerIds]).filter(Boolean);
  const seen = new Map();
  for (const id of ids) {
    const invs = (await query(at, rlm, `SELECT * FROM Invoice WHERE CustomerRef = '${id}' AND Balance > '0' ORDERBY TxnDate`)).Invoice || [];
    invs.forEach((i) => seen.set(i.Id, i));
  }
  return [...seen.values()];
}

async function createPayment(at, rlm, { customerId, amount, invoiceId }) {
  const body = { CustomerRef: { value: String(customerId) }, TotalAmt: amount, Line: [{ Amount: amount, LinkedTxn: [{ TxnId: String(invoiceId), TxnType: "Invoice" }] }] };
  const r = await fetch(`${BASE}/v3/company/${rlm}/payment?minorversion=70`, {
    method: "POST", headers: { Authorization: `Bearer ${at}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`QBO createPayment ${r.status}: ${JSON.stringify(d).slice(0, 220)}`);
  return d.Payment;
}

module.exports = { accessToken, realm, findCustomers, openInvoices, createPayment, ENV };
