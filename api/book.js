// Schedule Online submission → GHL contact upsert, then run the DispatchAI engine
// in-process (same logic the n8n workflow used) instead of forwarding to the GHL
// webhook. Dispatch assigns the nearest available rep and books the chosen slot.

const upsertGhlContact = require("./_ghl-contact");
const { runDispatch } = require("./dispatch");
const { trackLead, clientIp } = require("./_hyros");

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

  // Track the lead in HYROS (server-side, non-blocking).
  const hy = await trackLead({ firstName, lastName, email, phone, ip: clientIp(req), tags: ["online-booking", "website"], source: "Website — Direct Booking Form" });
  if (hy && hy.error) console.error("[book] HYROS track failed:", hy.error);

  // 2) Run the DispatchAI engine in-process (replaces the GHL workflow webhook):
  //    geocode lead → nearest qualified rep who is free at the chosen slot →
  //    book it in GHL → confirmation email / Slack / memory.
  let dispatch = null, dispatchErr = null;
  try {
    dispatch = await runDispatch({
      ...b,
      contact_id: contactId || b.contact_id || "",
      phone,
      full_address: b.address_full || b.full_address ||
        [b.address_street, b.address_city, b.address_state, b.address_zip].filter(Boolean).join(", "),
    });
  } catch (e) { dispatchErr = String(e.message || e); console.error("[book] dispatch failed:", dispatchErr); }

  const booked = !!dispatch && dispatch.status === "booked";

  console.log("[book-audit] " + JSON.stringify({
    ts: new Date().toISOString(), lead: `${firstName} ${lastName}`.trim(), email, phone,
    ghl_contact_id: contactId, ghl_contact_new: isNewContact, ghl_error: contactErr,
    dispatch_status: dispatch ? dispatch.status : null, dispatch_remarks: dispatch ? dispatch.remarks : null, dispatch_error: dispatchErr,
    preferred_date: b.preferred_date || null, selected_slot: b.selected_slot || null,
  }));

  if (!booked) {
    // Contact is captured in GHL, but no appointment was booked (no nearby/available rep, bad address, etc.).
    res.status(502).json({
      ok: false, contact_id: contactId,
      status: dispatch ? dispatch.status : "error",
      error: (dispatch && dispatch.remarks) || dispatchErr || "Booking could not be completed. Please try again or call us.",
    });
    return;
  }
  res.status(200).json({ ok: true, contact_id: contactId, status: dispatch.status, remarks: dispatch.remarks });
};
