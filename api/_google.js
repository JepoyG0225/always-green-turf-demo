// Google service-account auth (zero-dep). Signs a JWT with the SA private key
// and exchanges it for an access token. Configure in Vercel env:
//   GOOGLE_SA_EMAIL         = the service account's client_email
//   GOOGLE_SA_PRIVATE_KEY   = its private_key (PEM; \n escapes are handled)
// Then share the target Google Sheet with GOOGLE_SA_EMAIL (Editor).
const crypto = require("crypto");

const SA_EMAIL = process.env.GOOGLE_SA_EMAIL || "";
const SA_KEY = (process.env.GOOGLE_SA_PRIVATE_KEY || "").replace(/\\n/g, "\n");

async function accessToken(scope) {
  if (!SA_EMAIL || !SA_KEY) throw new Error("Google service account not configured (GOOGLE_SA_EMAIL / GOOGLE_SA_PRIVATE_KEY)");
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({
    iss: SA_EMAIL, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  })}`;
  const sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(SA_KEY).toString("base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error(`Google token ${r.status}: ${JSON.stringify(d).slice(0, 150)}`);
  return d.access_token;
}

module.exports = { accessToken };
