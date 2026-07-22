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

async function findCustomer(at, rlm, { email, name, company }) {
  if (email) { const c = (await query(at, rlm, `SELECT * FROM Customer WHERE PrimaryEmailAddr = '${esc(email)}'`)).Customer; if (c && c.length) return c[0]; }
  const dn = company || name;
  if (dn) { const c = (await query(at, rlm, `SELECT * FROM Customer WHERE DisplayName = '${esc(dn)}'`)).Customer; if (c && c.length) return c[0]; }
  return null;
}

async function openInvoices(at, rlm, customerId) {
  return (await query(at, rlm, `SELECT * FROM Invoice WHERE CustomerRef = '${customerId}' AND Balance > '0' ORDERBY TxnDate`)).Invoice || [];
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

module.exports = { accessToken, realm, findCustomer, openInvoices, createPayment, ENV };
