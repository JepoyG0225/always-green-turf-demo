// Call-back request → Slack notification (Vercel serverless function, no deps).
// Posts to the same channel the n8n "Direct Booking" flow used (C0BAZDCT5K4)
// via chat.postMessage. The Slack bot token stays server-side (env var).

const SLACK_CHANNEL = process.env.SLACK_CHANNEL_ID || "C0BAZDCT5K4"; // "direct-booking-appt"
const upsertGhlContact = require("./_ghl-contact");
const { trackLead, clientIp } = require("./_hyros");

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return {}; }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }

  const body = await readBody(req);
  const fullName = String(body.full_name || "").trim();
  const phone = String(body.phone || "").trim();

  // Honeypot: bots fill hidden fields.
  if (body.company) { res.status(200).json({ ok: true }); return; }
  if (!fullName || !phone) { res.status(400).json({ error: "Full name and phone number are required." }); return; }

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) { res.status(500).json({ error: "Slack is not configured (SLACK_BOT_TOKEN missing)." }); return; }

  // Upsert GHL contact (idempotent — deduped by email/phone).
  const [firstName, ...rest] = fullName.split(/\s+/);
  const lastName = rest.join(" ");
  let contactId = null, isNewContact = null, contactErr = null;
  try {
    const c = await upsertGhlContact({
      firstName, lastName, phone,
      tags: ["requestcallback", "callback-request", "website"],
      source: "Website — Call Me to Schedule",
    });
    contactId = c.id; isNewContact = c.new;
  } catch (e) { contactErr = String(e.message || e); console.error("[callback] GHL upsert failed:", contactErr); }

  // Track the lead in HYROS (server-side, non-blocking).
  const hy = await trackLead({ firstName, lastName, phone, ip: clientIp(req), tags: ["callback-request", "website"], source: "Website — Call Me to Schedule" });
  if (hy && hy.error) console.error("[callback] HYROS track failed:", hy.error);

  const text =
    `📞 *New Call-Back Request*\n\n` +
    `*Name:* ${fullName}\n` +
    `*Phone:* ${phone}\n` +
    (contactId ? `*GHL Contact:* <https://app.gohighlevel.com/v2/location/${process.env.GHL_LOCATION_ID || "dpp7zOnwhkHGWhn5lGRd"}/contacts/detail/${contactId}|${isNewContact ? "created" : "updated"}>\n` : contactErr ? `*GHL:* _contact upsert failed — ${contactErr}_\n` : "") +
    `*Source:* Website booking page — "Call me to schedule"`;

  const slack = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: SLACK_CHANNEL, text }),
  });
  const data = await slack.json();
  if (!data.ok) { res.status(502).json({ error: `Slack error: ${data.error}` }); return; }

  // Persist to dispatch_logs so callbacks show up in the /dispatch admin.
  const SUPA = process.env.SUPABASE_URL || "https://otgpzpepmurbydcghygb.supabase.co";
  const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (SKEY) {
    await fetch(`${SUPA}/rest/v1/dispatch_logs`, {
      method: "POST",
      headers: { apikey: SKEY, Authorization: `Bearer ${SKEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        status: "callback_request",
        contact_id: contactId,
        lead_name: fullName,
        remarks: `Call-back requested — ${phone}. ${contactId ? `GHL contact ${isNewContact ? "created" : "updated"}.` : contactErr ? "GHL contact upsert failed." : ""}`.trim(),
        error: contactErr,
        raw_payload: { full_name: fullName, phone, source: "Call Me to Schedule" },
      }),
    }).catch((e) => console.error("[callback] log write failed:", String(e.message || e)));
  }

  console.log("[callback-audit] " + JSON.stringify({ ts: new Date().toISOString(), full_name: fullName, phone, ghl_contact_id: contactId, ghl_contact_new: isNewContact, ghl_error: contactErr }));
  res.status(200).json({ ok: true, contact_id: contactId });
};
