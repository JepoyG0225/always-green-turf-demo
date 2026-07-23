// Serve a quote PDF from Vercel Blob under our own domain.
// Reached via the /quote-pdfs/:file rewrite; streams the blob so the URL stays
// on alwaysgreenturfaz.com instead of the blob host.
const { list } = require("@vercel/blob");

module.exports = async function handler(req, res) {
  const file = String((req.query && req.query.file) || "").replace(/[^a-zA-Z0-9._-]/g, "");
  if (!file) { res.status(400).send("bad request"); return; }
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) { res.status(500).send("blob not configured"); return; }
  try {
    const pathname = `quote-pdfs/${file}`;
    const { blobs } = await list({ prefix: pathname, limit: 1, token });
    const hit = (blobs || []).find((b) => b.pathname === pathname) || (blobs || [])[0];
    if (!hit) { res.status(404).send("not found"); return; }
    const r = await fetch(hit.url);
    if (!r.ok) { res.status(r.status).send("not available"); return; }
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${file}"`);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.status(200).send(buf);
  } catch (e) {
    res.status(500).send("error: " + String((e && e.message) || e));
  }
};
