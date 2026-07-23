// TEMP: pick a default QBO item + grab recent Jobber job/invoice ids for testing.
const jobber = require("./_jobber");
const qbo = require("./_qbo");
const JVER = process.env.JOBBER_QUOTE_GRAPHQL_VERSION || "2025-04-16";
async function jgql(at, q) {
  const r = await fetch("https://api.getjobber.com/api/graphql", {
    method: "POST", headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json", "X-JOBBER-GRAPHQL-VERSION": JVER },
    body: JSON.stringify({ query: q }),
  });
  return r.json();
}
module.exports = async function handler(req, res) {
  const out = {};
  try {
    const qat = await qbo.accessToken();
    const rlm = await qbo.realm();
    const items = (await qbo.query(qat, rlm, "SELECT Id, Name, Type FROM Item WHERE Type = 'Service' MAXRESULTS 300")).Item || [];
    out.serviceItems = items.map((i) => ({ id: i.Id, name: i.Name }));
  } catch (e) { out.qboErr = String(e.message || e); }
  try {
    const jat = await jobber.accessToken();
    const j = await jgql(jat, `{ jobs(first:5){ nodes{ id jobNumber title client{ name } } } invoices(first:5){ nodes{ id invoiceNumber client{ name } } } }`);
    out.jobs = ((j.data && j.data.jobs && j.data.jobs.nodes) || []).map((n) => ({ id: n.id, jobNumber: n.jobNumber, title: n.title, client: n.client && n.client.name }));
    out.invoices = ((j.data && j.data.invoices && j.data.invoices.nodes) || []).map((n) => ({ id: n.id, invoiceNumber: n.invoiceNumber, client: n.client && n.client.name }));
    out.jobberErr = j.errors;
  } catch (e) { out.jobberErr = String(e.message || e); }
  res.status(200).json(out);
};
