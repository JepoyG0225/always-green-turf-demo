// Public subcontractor takeoff form — token-based (no login).
//   GET  /api/sub-takeoff?token=tk_...            → the pre-filled takeoff
//   POST /api/sub-takeoff  { token, lines, completion_photos } → submit
// On submit, per-line override images and completion photos are hosted on Vercel
// Blob, the record is marked submitted, and the photos post to Slack.
const { put } = require("@vercel/blob");

const SUPA = process.env.SUPABASE_URL || "https://otgpzpepmurbydcghygb.supabase.co";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const H = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || "https://always-green-turf-demo.vercel.app").replace(/\/$/, "");
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_CHANNEL = process.env.SLACK_JOB_COMPLETE_CHANNEL || process.env.SLACK_CHANNEL_ID || "C0BAZDCT5K4";
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const money = (n) => Number(num(n, 0).toFixed(2));

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = []; for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return {}; }
}
async function getByToken(token) {
  const r = await fetch(`${SUPA}/rest/v1/sub_takeoffs?token=eq.${encodeURIComponent(token)}&select=*`, { headers: H });
  const rows = await r.json().catch(() => []);
  return rows[0] || null;
}
// Upload a data: URL to Vercel Blob, return the public URL (or null).
let imgSeq = 0;
async function hostImage(dataUrl, prefix) {
  if (!dataUrl || typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return null;
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/.exec(dataUrl);
  if (!m) return null;
  const ext = (m[1].split("/")[1] || "jpg").replace("jpeg", "jpg");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 12 * 1024 * 1024) throw new Error("image too large (max 12MB)");
  const name = `sub-takeoffs/${prefix}-${Date.now()}-${imgSeq++}.${ext}`;
  const blob = await put(name, buf, { access: "public", addRandomSuffix: true, contentType: m[1], token: process.env.BLOB_READ_WRITE_TOKEN });
  return blob.url;
}
async function notifySlack(text, imageUrls) {
  if (!SLACK_TOKEN) return;
  const blocks = [{ type: "section", text: { type: "mrkdwn", text } }];
  (imageUrls || []).slice(0, 8).forEach((u) => blocks.push({ type: "image", image_url: u, alt_text: "completed work" }));
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST", headers: { Authorization: `Bearer ${SLACK_TOKEN}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: SLACK_CHANNEL, text, blocks }),
  }).catch(() => {});
}

module.exports = async function handler(req, res) {
  if (!SERVICE) { res.status(500).json({ error: "not configured" }); return; }

  if (req.method === "GET") {
    const token = (req.query && req.query.token) || "";
    if (!token) { res.status(400).json({ error: "token required" }); return; }
    const t = await getByToken(token);
    if (!t) { res.status(404).json({ error: "This form link is invalid or has expired." }); return; }
    let subName = null;
    if (t.subcontractor_id) {
      const sr = await fetch(`${SUPA}/rest/v1/subcontractors?id=eq.${t.subcontractor_id}&select=name`, { headers: H });
      const s = await sr.json().catch(() => []); subName = s[0] && s[0].name;
    }
    res.status(200).json({ ok: true, takeoff: {
      job_number: t.job_number, client_name: t.client_name, subcontractor: subName,
      status: t.status, line_items: t.line_items || [], submitted_at: t.submitted_at,
    } });
    return;
  }

  if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }
  const body = await readBody(req);
  const token = body.token || "";
  const t = await getByToken(token);
  if (!t) { res.status(404).json({ error: "invalid form link" }); return; }
  if (t.status !== "sent" && t.status !== "submitted") { res.status(409).json({ error: `This takeoff is already ${t.status}.` }); return; }

  try {
    const inLines = Array.isArray(body.lines) ? body.lines : [];
    const orig = t.line_items || [];
    // Merge the sub's confirm/override/photo onto the stored lines, by index.
    const lines = [];
    for (let i = 0; i < orig.length; i++) {
      const o = orig[i]; const u = inLines[i] || {};
      const confirmed = u.confirmed !== false;
      let overrideCost = u.override_cost != null && u.override_cost !== "" ? money(u.override_cost) : null;
      const overrideComment = (u.override_comment || "").trim() || null;
      // A price change requires a comment — enforce server-side too.
      if (overrideCost != null && overrideCost !== money(o.agreed_cost) && !overrideComment) {
        throw new Error(`Line "${o.name}": a price change needs a comment.`);
      }
      let overrideImg = o.override_image_url || null;
      if (u.override_image) overrideImg = await hostImage(u.override_image, `ovr-${t.job_number}`) || overrideImg;
      const qty = num(o.qty, 1);
      const effCost = overrideCost != null ? overrideCost : num(o.agreed_cost, 0);
      lines.push({ ...o, confirmed, override_cost: overrideCost, override_comment: overrideComment,
        override_image_url: overrideImg, line_total: money(effCost * qty) });
    }
    // Completion photos (required)
    const photoInputs = Array.isArray(body.completion_photos) ? body.completion_photos : [];
    const photos = [];
    for (const p of photoInputs) { const url = await hostImage(p, `job-${t.job_number}`); if (url) photos.push({ url }); }
    if (!photos.length && (!t.completion_photos || !t.completion_photos.length)) {
      throw new Error("At least one photo of the completed work is required.");
    }
    const finalPhotos = photos.length ? photos : (t.completion_photos || []);
    const total = money(lines.filter((l) => l.confirmed).reduce((s, l) => s + num(l.line_total), 0));

    const patch = { line_items: lines, completion_photos: finalPhotos, total_amount: total,
      status: "submitted", submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    const r = await fetch(`${SUPA}/rest/v1/sub_takeoffs?token=eq.${encodeURIComponent(token)}`, { method: "PATCH", headers: { ...H, Prefer: "return=minimal" }, body: JSON.stringify(patch) });
    if (!r.ok) throw new Error(`save failed ${r.status}`);

    const confirmedCount = lines.filter((l) => l.confirmed).length;
    const overrides = lines.filter((l) => l.confirmed && l.override_cost != null);
    await notifySlack(
      `🧾 *Subcontractor takeoff submitted* — job #${t.job_number} (${t.client_name})\n` +
      `*Lines billed:* ${confirmedCount}   *Total:* $${total.toLocaleString()}` +
      (overrides.length ? `\n*Price adjustments:* ${overrides.map((o) => `${o.name} → $${o.override_cost} (${o.override_comment})`).join("; ")}` : "") +
      `\n_Review & approve in the admin panel._`,
      finalPhotos.map((p) => p.url));

    res.status(200).json({ ok: true, total, confirmed: confirmedCount });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
};
