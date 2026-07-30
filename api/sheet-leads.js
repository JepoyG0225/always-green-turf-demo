// Google Sheet → GHL lead capture. Polls a lead sheet on a schedule (Vercel
// cron), upserts each new row as a GHL contact, also tracks it in HYROS, and
// stamps a "GHL Synced" column so a row is never processed twice.
//
// Columns are matched by HEADER NAME (case-insensitive), so the sheet layout is
// flexible. Configure with env: LEAD_SHEET_ID, LEAD_SHEET_TAB (default "Leads").
//   GET  /api/sheet-leads              → cron sync (verifies Vercel cron / secret)
//   POST /api/sheet-leads { dryRun }    → manual sync (dryRun previews, writes nothing)
const newRun = require("./_runlog");
const google = require("./_google");
const upsertGhlContact = require("./_ghl-contact");
const { isPublished } = require("./_workflow-config");
const { trackLead } = require("./_hyros");

const SHEET_ID = process.env.LEAD_SHEET_ID || "";
const SHEET_TAB = process.env.LEAD_SHEET_TAB || "Leads";
const CRON_SECRET = process.env.CRON_SECRET || "";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const clean = (v) => (v == null ? "" : String(v).trim());

// Header aliases → our field. Headers are normalized (underscores/dashes → space)
// so Meta Lead-Ads columns like "full_name"/"phone_number" match too.
const FIELD_ALIASES = {
  firstName: ["first name", "firstname", "first", "fname"],
  lastName: ["last name", "lastname", "last", "lname"],
  fullName: ["name", "full name", "contact name", "lead name"],
  email: ["email", "email address", "e mail"],
  phone: ["phone", "phone number", "mobile", "cell"],
  address1: ["address", "street", "address 1", "street address"],
  city: ["city"],
  state: ["state", "province"],
  postalCode: ["zip", "zip code", "postal", "postal code", "zipcode"],
  source: ["source", "lead source", "utm source"],
  campaign: ["campaign name", "campaign", "ad name", "adset name"],
  platform: ["platform"],
  status: ["lead status", "status"],
  synced: ["ghl synced", "synced", "synced at", "ghl synced at"],
};
// Meta injects test leads (lead_status "test"/"tested", the test@fb/meta domains,
// or "dummy data" placeholders). Never push these to GHL.
function isTestLead({ status, email, firstName, lastName, phone }) {
  const s = (status || "").toLowerCase();
  if (s === "test" || s === "tested") return true;
  const blob = `${email} ${firstName} ${lastName} ${phone}`.toLowerCase();
  if (/dummy data|test lead|<test/.test(blob)) return true;
  if (/@(meta|fb)\.com$/i.test(email || "")) return true;
  return false;
}
const normHeader = (h) => clean(h).toLowerCase().replace(/[_\-]+/g, " ").replace(/[?.&]/g, "").replace(/\s+/g, " ").trim();
function mapHeaders(header) {
  const idx = {};
  header.forEach((h, i) => {
    const hn = normHeader(h);
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      if (idx[field] == null && aliases.includes(hn)) idx[field] = i;
    }
  });
  return idx;
}
// Meta prefixes values with a type tag (phone "p:+1480…", id "l:123"). Strip it.
const stripMetaPrefix = (v) => clean(v).replace(/^[a-z]{1,3}:/i, "");
const colLetter = (i) => { let s = "", n = i; do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0); return s; };

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = []; for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return {}; }
}

async function sync({ dryRun }) {
  const run = newRun("sheet-leads", { sheet: SHEET_ID, tab: SHEET_TAB, dryRun });
  try {
    if (!dryRun && !(await isPublished("sheet-leads"))) { run.info("Unpublished — skipped", {}); await run.finish("skipped", "Workflow is unpublished"); return { ok: true, skipped: "unpublished" }; }
    if (!SHEET_ID) throw new Error("LEAD_SHEET_ID not set");

    const token = await run.step("Google auth", {}, () => google.accessToken(SCOPE));
    // Resolve the tab: use the configured one if it exists, else the first sheet.
    const tab = await run.step("Resolve tab", { configured: SHEET_TAB }, async () => {
      const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties.title`, { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`Sheets meta ${r.status}: ${JSON.stringify(d).slice(0, 150)}`);
      const titles = (d.sheets || []).map((s) => s.properties && s.properties.title).filter(Boolean);
      return (SHEET_TAB && titles.includes(SHEET_TAB)) ? SHEET_TAB : (titles[0] || SHEET_TAB);
    });
    const rows = await run.step("Read sheet", { tab }, async () => {
      const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(tab)}`, { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`Sheets read ${r.status}: ${JSON.stringify(d).slice(0, 150)}`);
      return d.values || [];
    });
    if (rows.length < 2) { await run.finish("info", "No data rows in sheet"); return { ok: true, processed: 0 }; }

    const header = rows[0];
    const idx = mapHeaders(header);
    if (idx.email == null && idx.phone == null) throw new Error(`Sheet needs an Email or Phone column. Headers seen: ${header.join(", ")}`);

    // Auto-create a "GHL Synced" column if the sheet doesn't have one yet.
    let syncedCol = idx.synced;
    if (syncedCol == null) {
      syncedCol = header.length;
      if (!dryRun) {
        await run.step("Add 'GHL Synced' column", { col: colLetter(syncedCol) }, async () => {
          const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(`${tab}!${colLetter(syncedCol)}1`)}?valueInputOption=USER_ENTERED`, {
            method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ values: [["GHL Synced"]] }),
          });
          if (!r.ok) throw new Error(`add header ${r.status}`); return { ok: true };
        });
      }
    }

    const results = [], stamps = [];
    const stampTime = new Date().toISOString();
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (clean(row[syncedCol])) continue; // already synced
      const get = (f) => (idx[f] != null ? clean(row[idx[f]]) : "");
      let firstName = get("firstName"), lastName = get("lastName");
      if (!firstName && idx.fullName != null) { const parts = get("fullName").split(/\s+/).filter(Boolean); firstName = parts[0] || ""; lastName = parts.slice(1).join(" "); }
      const email = get("email");
      const phone = stripMetaPrefix(get("phone"));
      if (!email && !phone) continue; // blank row
      if (isTestLead({ status: get("status"), email, firstName, lastName, phone })) {
        results.push({ row: r + 1, email, phone, skipped: "test lead" });
        if (!dryRun) stamps.push({ range: `${tab}!${colLetter(syncedCol)}${r + 1}`, values: [["skipped (test)"]] });
        continue;
      }
      const platform = get("platform");
      const source = get("source") || get("campaign") || (platform ? `${platform === "ig" ? "Instagram" : platform === "fb" ? "Facebook" : platform} Lead Ad` : "Google Sheet Import");
      const tags = ["facebook-lead", "website"]; if (platform) tags.push(platform === "ig" ? "instagram" : platform === "fb" ? "facebook" : platform);
      const lead = { firstName, lastName, email, phone,
        address1: get("address1"), city: get("city"), state: get("state"), postalCode: get("postalCode"),
        tags, source };

      if (dryRun) { results.push({ row: r + 1, email, phone, name: [firstName, lastName].filter(Boolean).join(" "), would: "upsert" }); continue; }

      try {
        const c = await upsertGhlContact(lead);
        trackLead(lead).catch(() => {}); // best-effort HYROS
        results.push({ row: r + 1, contactId: c.id, new: c.new, email, phone });
        stamps.push({ range: `${tab}!${colLetter(syncedCol)}${r + 1}`, values: [[stampTime]] });
      } catch (e) {
        results.push({ row: r + 1, email, phone, error: String(e.message || e) });
      }
    }

    // Stamp the Synced column for every row we successfully pushed.
    if (stamps.length && !dryRun) {
      await run.step("Stamp synced rows", { count: stamps.length }, async () => {
        const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchUpdate`, {
          method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ valueInputOption: "USER_ENTERED", data: stamps }),
        });
        if (!r.ok) throw new Error(`stamp ${r.status}: ${(await r.text()).slice(0, 150)}`);
        return { stamped: stamps.length };
      });
    }

    const synced = results.filter((x) => x.contactId).length;
    const failed = results.filter((x) => x.error).length;
    await run.finish(dryRun ? "dry_run" : (failed ? "info" : "success"),
      dryRun ? `DRY RUN — ${results.length} new row(s) would sync to GHL` : `Synced ${synced} lead(s) to GHL${failed ? `, ${failed} failed` : ""}`);
    return { ok: true, dryRun: !!dryRun, processed: results.length, synced, failed, results: results.slice(0, 50) };
  } catch (e) { await run.finish("error", String(e.message || e)); throw e; }
}

module.exports = async function handler(req, res) {
  // Cron (GET): verify Vercel's cron header or a shared secret so it isn't public.
  if (req.method === "GET") {
    const auth = req.headers.authorization || "";
    const okCron = CRON_SECRET ? auth === `Bearer ${CRON_SECRET}` : true;
    const okQuery = CRON_SECRET && req.query && req.query.secret === CRON_SECRET;
    if (CRON_SECRET && !okCron && !okQuery) { res.status(401).json({ error: "unauthorized" }); return; }
    try { res.status(200).json(await sync({ dryRun: false })); }
    catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
    return;
  }
  if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }
  const body = await readBody(req);
  try { res.status(200).json(await sync({ dryRun: body.dryRun === true })); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
};
