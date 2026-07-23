// GHL contact webhook → append a row to the "Master Sheet" (Google Sheets).
// Ported from the n8n "GHL-Add to Master Sheet" workflow:
//   webhook (body.contact_id) → GET full GHL contact → append row.
// Every step is recorded via _runlog for the execution viewer.

const newRun = require("./_runlog");
const google = require("./_google");
const { isPublished } = require("./_workflow-config");

const GHL_TOKEN = process.env.GHL_MASTERSHEET_TOKEN || process.env.GHL_API_TOKEN || "pit-9ce64e63-b959-40a9-a58d-9cd6e7fcc32e";
const SHEET_ID = process.env.MASTER_SHEET_ID || "111__Cz0LjUMH17S-wt8UoKmk3_QGWEdh3dMI9v8m5U0";
const SHEET_NAME = process.env.MASTER_SHEET_NAME || "Master Sheet";

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = []; for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return {}; }
}

// "Jul 23, 2026 2:53 PM" — matches the n8n formatter (UTC, as on n8n cloud).
function fmtLastActivity(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const day = String(d.getUTCDate()).padStart(2, "0");
  const year = d.getUTCFullYear();
  let h = d.getUTCHours(); const m = String(d.getUTCMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
  return `${month} ${day}, ${year} ${h}:${m} ${ampm}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  const body = await readBody(req);
  const contactId = body.contact_id || body.contactId || (body.contact && body.contact.id) || "";
  const run = newRun("ghl-master-sheet", body);

  try {
    if (!(await isPublished("ghl-master-sheet"))) { run.info("Workflow unpublished — skipped", {}); await run.finish("skipped", "Workflow is unpublished"); res.status(200).json({ ok: true, skipped: "unpublished" }); return; }
    if (!contactId) throw new Error("no contact_id in webhook body");

    // 1) Fetch the full contact from GoHighLevel.
    const contact = await run.step("Search Contact (GHL)", { contactId }, async () => {
      const r = await fetch(`https://services.leadconnectorhq.com/contacts/${encodeURIComponent(contactId)}`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${GHL_TOKEN}`, Version: "2021-07-28" },
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`GHL ${r.status}: ${JSON.stringify(d).slice(0, 150)}`);
      if (!d.contact) throw new Error("GHL returned no contact");
      return d.contact;
    });

    // 2) Build the row, keyed by column header (matched to the sheet below).
    const first = contact.firstName || ""; const last = contact.lastName || "";
    const fields = {
      "Contact Id": contact.id || contactId,
      "First Name": first,
      "Last Name": last,
      "Name": `${first} ${last}`.trim(),
      "Phone": contact.phone || "",
      "Email": contact.email || "",
      "Created": (contact.createdBy && contact.createdBy.timestamp) || contact.dateAdded || "",
      "Source": contact.source || "",
      "Last Activity": fmtLastActivity(contact.dateUpdated),
    };

    // 3) Google auth (token intentionally NOT logged).
    let gtoken;
    await run.step("Google auth", {}, async () => { gtoken = await google.accessToken("https://www.googleapis.com/auth/spreadsheets"); return { ok: true }; });

    // 4) Read the header row so we place values under the right columns.
    const header = await run.step("Read sheet header", { sheet: SHEET_NAME }, async () => {
      const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(`${SHEET_NAME}!1:1`)}`, { headers: { Authorization: `Bearer ${gtoken}` } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`Sheets header ${r.status}: ${JSON.stringify(d).slice(0, 150)}`);
      const h = (d.values && d.values[0]) || [];
      if (!h.length) throw new Error(`no header row found in "${SHEET_NAME}"`);
      return h;
    });
    const row = header.map((h) => (h in fields ? fields[h] : ""));

    // 5) Append the row.
    const appended = await run.step("Append row (Master Sheet)", { fields }, async () => {
      const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(`${SHEET_NAME}!A1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
        method: "POST", headers: { Authorization: `Bearer ${gtoken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: [row] }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`Sheets append ${r.status}: ${JSON.stringify(d).slice(0, 150)}`);
      return { updatedRange: d.updates && d.updates.updatedRange };
    });

    await run.finish("success", `Added ${fields.Name || contactId} to ${SHEET_NAME} (${appended.updatedRange || "ok"})`);
    res.status(200).json({ ok: true, contact: fields.Name, range: appended.updatedRange });
  } catch (e) {
    await run.finish("error", String(e.message || e));
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
