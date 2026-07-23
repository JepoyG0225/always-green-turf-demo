// Google service-account auth (zero-dep). Signs a JWT with the SA private key
// and exchanges it for an access token.
//
// Preferred (paste-safe) config — ONE env var:
//   GOOGLE_SA_KEY_JSON_B64 = base64 of the whole downloaded service-account .json
//     (mac:  base64 -i key.json | pbcopy)
// Fallback config — two vars:
//   GOOGLE_SA_EMAIL, GOOGLE_SA_PRIVATE_KEY
// Then share the target Google Sheet with the service account email (Editor).
const crypto = require("crypto");

function normalizeKey(raw) {
  let k = (raw || "").trim();
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) k = k.slice(1, -1);
  return k.replace(/\\r/g, "").replace(/\\n/g, "\n").replace(/\r/g, "").trim();
}

function loadCreds() {
  const b64 = (process.env.GOOGLE_SA_KEY_JSON_B64 || "").trim();
  if (b64) {
    let j;
    try { j = JSON.parse(Buffer.from(b64, "base64").toString("utf8")); }
    catch { throw new Error("GOOGLE_SA_KEY_JSON_B64 is not valid base64 of the key JSON"); }
    return { email: (j.client_email || "").trim(), key: normalizeKey(j.private_key) };
  }
  return { email: (process.env.GOOGLE_SA_EMAIL || "").trim(), key: normalizeKey(process.env.GOOGLE_SA_PRIVATE_KEY) };
}

async function accessToken(scope) {
  const { email, key } = loadCreds();
  if (!email || !key) throw new Error("Google service account not configured (set GOOGLE_SA_KEY_JSON_B64)");
  if (!key.includes("-----BEGIN")) throw new Error("private key is malformed (missing PEM header) — re-set GOOGLE_SA_KEY_JSON_B64");
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({
    iss: email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  })}`;
  const sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(key).toString("base64url");
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
