// QuickBooks Online OAuth callback — exchanges the auth code for tokens and
// stores the (rotating) refresh token in Supabase.
const { saveToken } = require("./_integration-tokens");

function page(res, body) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:640px;margin:60px auto;padding:0 20px;color:#1f2937;line-height:1.6">${body}</body>`);
}

module.exports = async function handler(req, res) {
  const q = req.query || {};
  if (q.error) { page(res, `<h2>❌ QuickBooks authorization failed</h2><p><code>${q.error}</code></p>`); return; }
  if (!q.code) { page(res, `<h2>Missing authorization code</h2>`); return; }

  const CID = process.env.QBO_CLIENT_ID, CSEC = process.env.QBO_CLIENT_SECRET;
  const redirect = `https://${req.headers.host}/api/qbo-callback`;
  const basic = Buffer.from(`${CID}:${CSEC}`).toString("base64");
  const body = new URLSearchParams({ grant_type: "authorization_code", code: String(q.code), redirect_uri: redirect });

  try {
    const r = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.refresh_token) { page(res, `<h2>❌ Token exchange failed</h2><pre>${JSON.stringify(data).slice(0, 400)}</pre>`); return; }

    const realm = q.realmId || process.env.QBO_REALM_ID || "";
    let stored = true, err = "";
    try {
      await saveToken("qbo", data.refresh_token);
      if (realm) await saveToken("qbo_realm", realm); // capture the authorized company id
    } catch (e) { stored = false; err = String(e.message || e); }

    page(res,
      `<h2>✅ QuickBooks Online connected</h2>
       <p>Company (realm) id: <code>${realm}</code></p>
       <p>Refresh token ${stored ? "stored in Supabase ✔" : `<strong>NOT stored</strong> — ${err}`}.</p>
       ${stored ? "<p>You can close this tab. The payment workflow can now reach QuickBooks.</p>"
                : `<p>Copy this refresh token and send it to your admin:</p><p><code style="word-break:break-all">${data.refresh_token}</code></p>`}`);
  } catch (e) {
    page(res, `<h2>❌ Error</h2><pre>${String(e.message || e).slice(0, 300)}</pre>`);
  }
};
