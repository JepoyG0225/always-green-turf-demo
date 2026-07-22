// One-time Jobber authorization — redirects to Jobber's consent screen.
// Visit https://www.alwaysgreenturfaz.com/api/jobber-connect to connect.
module.exports = async function handler(req, res) {
  const CID = process.env.JOBBER_CLIENT_ID;
  if (!CID) { res.status(500).send("JOBBER_CLIENT_ID not set"); return; }
  // Must exactly match the redirect URI registered in the Jobber app.
  const redirect = process.env.JOBBER_REDIRECT_URI || "https://alwaysgreenturfaz.com/jobber/oauth/callback";
  const url = new URL("https://api.getjobber.com/api/oauth/authorize");
  url.searchParams.set("client_id", CID);
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", "jobber-" + Math.abs(Date.now() % 1e9));
  res.writeHead(302, { Location: url.toString() });
  res.end();
};
