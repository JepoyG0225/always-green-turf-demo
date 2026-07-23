// ArcSite "signed/approved proposal" webhook → attach the signed PDF as a note
// on the customer's Jobber quote. Ported from n8n "Arcsite-Signed Proposal to Jobber".
//
// Two fixes vs the n8n original:
//   - it used the CLIENT id as quoteCreateNote's quoteId (a bug); we use the QUOTE id.
//   - it linked the expiring ArcSite URL; we re-host the PDF on Vercel Blob for a
//     permanent link on our domain (falling back to the raw URL if hosting fails).
//
// Dry run: POST ?dryRun=1 → reports the plan without writing the note.

const newRun = require("./_runlog");
const jobber = require("./_jobber");
const { isPublished } = require("./_workflow-config");
const { put } = require("@vercel/blob");

const JVER = process.env.JOBBER_QUOTE_GRAPHQL_VERSION || "2025-04-16";
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || "https://always-green-turf-demo.vercel.app").replace(/\/$/, "");

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = []; for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return {}; }
}
const clean = (v) => (v == null ? "" : String(v).trim());

async function jobberGql(at, query, variables) {
  const r = await fetch("https://api.getjobber.com/api/graphql", {
    method: "POST", headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json", "X-JOBBER-GRAPHQL-VERSION": JVER },
    body: JSON.stringify({ query, variables }),
  });
  const d = await r.json().catch(() => ({}));
  if (d.errors) throw new Error(`Jobber gql: ${JSON.stringify(d.errors).slice(0, 250)}`);
  return d.data;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  const body = await readBody(req);
  const data = body.data || {};
  const dryRun = (req.query && req.query.dryRun === "1") || body.dryRun === true;

  const customerName = clean(data.customer_name);
  const status = clean(data.status);
  const pdfUrl = clean((data.approved_option && data.approved_option.pdf_url) || "");
  const run = newRun("arcsite-signed", body);
  const plan = { dryRun, status, customerName };

  try {
    if (!dryRun && !(await isPublished("arcsite-signed"))) { run.info("Workflow unpublished — skipped", {}); await run.finish("skipped", "Workflow is unpublished"); res.status(200).json({ ok: true, skipped: "unpublished" }); return; }

    // Gate: only proceed when the proposal is approved/signed.
    if (status.toUpperCase() !== "APPROVED") { run.info("Not approved — skipped", { status }); await run.finish("skipped", `status ${status || "—"} ≠ APPROVED`); res.status(200).json({ ok: true, skipped: "not-approved" }); return; }
    if (!customerName) throw new Error("no data.customer_name on webhook body");

    const at = await run.step("Jobber auth", {}, () => jobber.accessToken());

    // Find the client and their latest quote.
    const found = await run.step("Search client + quote in Jobber", { customerName }, async () => {
      const d = await jobberGql(at, `query($s:String!){ clients(searchTerm:$s){ nodes{ id name quotes(first:1){ nodes{ id quoteNumber quoteStatus createdAt } } } } }`, { s: customerName });
      const c = (d.clients && d.clients.nodes && d.clients.nodes[0]) || null;
      const q = c && c.quotes && c.quotes.nodes && c.quotes.nodes[0];
      return c ? { clientId: c.id, clientName: c.name, quote: q || null } : null;
    });
    if (!found) throw new Error(`No Jobber client found for "${customerName}"`);
    if (!found.quote) throw new Error(`Client "${found.clientName}" has no quote to attach the signed proposal to`);
    plan.quote = { id: found.quote.id, number: found.quote.quoteNumber };

    // Re-host the signed PDF on Vercel Blob (permanent, on our domain); fall back to raw URL.
    let noteUrl = pdfUrl;
    if (pdfUrl) {
      noteUrl = await run.step("Host signed PDF on Vercel Blob", { pdfUrl }, async () => {
        try {
          if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error("no BLOB token");
          const fileName = (pdfUrl.split("?")[0].split("/").pop() || "signed.pdf").replace(/[^a-zA-Z0-9._-]/g, "");
          const pr = await fetch(pdfUrl); if (!pr.ok) throw new Error(`PDF download ${pr.status}`);
          const buf = Buffer.from(await pr.arrayBuffer());
          await put(`quote-pdfs/${fileName}`, buf, { access: "public", addRandomSuffix: false, allowOverwrite: true, contentType: "application/pdf", token: process.env.BLOB_READ_WRITE_TOKEN });
          return `${PUBLIC_BASE}/quote-pdfs/${fileName}`;
        } catch (e) { return pdfUrl; } // fall back to the ArcSite URL
      });
    }
    plan.noteUrl = noteUrl;
    const message = `Signed Proposal PDF:\n${noteUrl}`;

    if (dryRun) {
      await run.finish("dry_run", `DRY RUN — would attach signed PDF note to quote #${found.quote.quoteNumber} for ${found.clientName}`);
      res.status(200).json({ ok: true, plan }); return;
    }

    // Attach the note to the quote.
    await run.step("Attach signed-PDF note to quote", { quoteId: found.quote.id, message }, async () => {
      const d = await jobberGql(at, `mutation($quoteId:EncodedId!,$msg:String!){ quoteCreateNote(quoteId:$quoteId,input:{message:$msg}){ quote{ id } userErrors{ message path } } }`, { quoteId: found.quote.id, msg: message });
      if (d.quoteCreateNote?.userErrors?.length) throw new Error(`quoteCreateNote: ${JSON.stringify(d.quoteCreateNote.userErrors)}`);
      return d.quoteCreateNote;
    });

    await run.finish("success", `Signed PDF note added to quote #${found.quote.quoteNumber} for ${found.clientName}`);
    res.status(200).json({ ok: true, quote: found.quote.quoteNumber, noteUrl });
  } catch (e) {
    await run.finish("error", String(e.message || e));
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
