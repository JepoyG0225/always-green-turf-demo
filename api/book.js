// Schedule Online submission → GHL contact upsert + forward to the workflow
// webhook that already exists (n8n/DispatchAI wiring). The form now goes here
// instead of straight to the GHL webhook, so we get an explicit contact_id.

const upsertGhlContact = require("./_ghl-contact");
const WEBHOOK = process.env.GHL_BOOKING_WEBHOOK_URL
  || "https://services.leadconnectorhq.com/hooks/dpp7zOnwhkHGWhn5lGRd/webhook-trigger/730329d9-f044-446f-9109-1ca35284f743";

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = []; for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return {}; }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }
  const b = await readBody(req);

  const firstName = String(b.first_name || "").trim();
  const lastName = String(b.last_name || "").trim();
  const email = String(b.email || "").trim();
  const phone = String(b.phone_formatted || b.phone || "").trim();
  if (!firstName || !phone) { res.status(400).json({ error: "first name and phone are required" }); return; }

  // 1) Upsert GHL contact (idempotent by email/phone).
  let contactId = null, isNewContact = null, contactErr = null;
  try {
    const c = await upsertGhlContact({
      firstName, lastName, email, phone,
      address1: String(b.address_street || b.address_full || "").trim(),
      city: String(b.address_city || "").trim(),
      state: String(b.address_state || "").trim(),
      postalCode: String(b.address_zip || "").trim(),
      tags: ["online-booking", "website"],
      source: "Website — Direct Booking Form",
    });
    contactId = c.id; isNewContact = c.new;
  } catch (e) { contactErr = String(e.message || e); console.error("[book] GHL upsert failed:", contactErr); }

  // 2) Forward to the existing GHL workflow webhook (kicks off downstream).
  //    Preserving every field the workflow already expects.
  let webhookOk = false, webhookStatus = 0, webhookErr = null;
  try {
    const forwardBody = { ...b, contact_id: contactId || b.contact_id };
    const r = await fetch(WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(forwardBody) });
    webhookStatus = r.status; webhookOk = r.ok;
    if (!r.ok) webhookErr = (await r.text()).slice(0, 200);
  } catch (e) { webhookErr = String(e.message || e); console.error("[book] webhook forward failed:", webhookErr); }

  console.log("[book-audit] " + JSON.stringify({
    ts: new Date().toISOString(), lead: `${firstName} ${lastName}`.trim(), email, phone,
    ghl_contact_id: contactId, ghl_contact_new: isNewContact, ghl_error: contactErr,
    webhook_ok: webhookOk, webhook_status: webhookStatus, webhook_error: webhookErr,
    preferred_date: b.preferred_date || null, selected_slot: b.selected_slot || null,
  }));

  // We succeed as long as one of the two paths landed.
  if (!contactId && !webhookOk) { res.status(502).json({ error: "Booking could not be sent. Please try again or call us." }); return; }
  res.status(200).json({ ok: true, contact_id: contactId, workflow_ok: webhookOk });
};
