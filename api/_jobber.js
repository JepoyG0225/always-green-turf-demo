// Jobber helper — token refresh (rotating), GraphQL, payment fetch, HMAC verify.
const crypto = require("crypto");
const { getToken, saveToken } = require("./_integration-tokens");
const CID = process.env.JOBBER_CLIENT_ID, CSEC = process.env.JOBBER_CLIENT_SECRET;
const VER = process.env.JOBBER_API_VERSION || "2023-11-15";

async function accessToken() {
  const rt = await getToken("jobber");
  if (!rt) throw new Error("Jobber not connected");
  const r = await fetch("https://api.getjobber.com/api/oauth/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: CID, client_secret: CSEC, grant_type: "refresh_token", refresh_token: rt }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error(`Jobber refresh ${r.status}: ${JSON.stringify(d).slice(0, 150)}`);
  if (d.refresh_token && d.refresh_token !== rt) await saveToken("jobber", d.refresh_token);
  return d.access_token;
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
         client { firstName lastName companyName email }
         allocations { nodes { amount invoice { invoiceNumber } } }
       }
     }`, { id });
  return d.paymentRecord;
}

// Jobber signs webhooks with base64(HMAC-SHA256(rawBody, clientSecret)) in X-Jobber-Hmac-SHA256.
function verifyHmac(rawBody, header) {
  if (!header || !CSEC) return false;
  const digest = crypto.createHmac("sha256", CSEC).update(rawBody, "utf8").digest("base64");
  try { return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(String(header))); } catch { return false; }
}

module.exports = { accessToken, gql, getPayment, verifyHmac };
