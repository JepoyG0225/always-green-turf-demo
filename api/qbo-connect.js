// One-time QuickBooks Online authorization — redirects to Intuit's consent screen.
// Visit https://www.alwaysgreenturfaz.com/api/qbo-connect to connect.
module.exports = async function handler(req, res) {
  const CID = process.env.QBO_CLIENT_ID;
  if (!CID) { res.status(500).send("QBO_CLIENT_ID not set"); return; }
  const redirect = `https://${req.headers.host}/api/qbo-callback`;
  const url = new URL("https://appcenter.intuit.com/connect/oauth2");
  url.searchParams.set("client_id", CID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "com.intuit.quickbooks.accounting");
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("state", "qbo-" + Math.abs(Date.now() % 1e9));
  res.writeHead(302, { Location: url.toString() });
  res.end();
};
