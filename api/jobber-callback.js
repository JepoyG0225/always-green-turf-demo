// Jobber OAuth callback — exchanges the auth code for tokens and stores the
// (rotating) refresh token in Supabase.
const { saveToken } = require("./_integration-tokens");

function page(res, body) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:640px;margin:60px auto;padding:0 20px;color:#1f2937;line-height:1.6">${body}</body>`);
}

module.exports = async function handler(req, res) {
  const q = req.query || {};
  if (q.error) { page(res, `<h2>❌ Jobber authorization failed</h2><p><code>${q.error}</code></p>`); return; }
  if (!q.code) { page(res, `<h2>Missing authorization code</h2>`); return; }

  const CID = process.env.JOBBER_CLIENT_ID, CSEC = process.env.JOBBER_CLIENT_SECRET;
  // Must be byte-identical to the redirect_uri used in jobber-connect + registered in the app.
  const redirect = process.env.JOBBER_REDIRECT_URI || "https://alwaysgreenturfaz.com/jobber/oauth/callback";
  const body = new URLSearchParams({
    client_id: CID, client_secret: CSEC, grant_type: "authorization_code",
    code: String(q.code), redirect_uri: redirect,
  });

  try {
    const r = await fetch("https://api.getjobber.com/api/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.refresh_token) { page(res, `<h2>❌ Token exchange failed</h2><pre>${JSON.stringify(data).slice(0, 400)}</pre>`); return; }

    let stored = true, err = "";
    try { await saveToken("jobber", data.refresh_token); } catch (e) { stored = false; err = String(e.message || e); }

    page(res,
      `<h2>✅ Jobber connected</h2>
       <p>Refresh token ${stored ? "stored in Supabase ✔" : `<strong>NOT stored</strong> — ${err}`}.</p>
       ${stored ? "<p>You can close this tab. The payment workflow can now reach Jobber.</p>"
                : `<p>Copy this refresh token and send it to your admin:</p><p><code style="word-break:break-all">${data.refresh_token}</code></p>`}`);
  } catch (e) {
    page(res, `<h2>❌ Error</h2><pre>${String(e.message || e).slice(0, 300)}</pre>`);
  }
};
