// Schedule Online submission → GHL contact upsert + DispatchAI engine.
// Runs the same logic as the old n8n workflow directly (nearest rep, book the
// customer's exact slot, email, Slack, memory, logs) — no GHL webhook trigger.
// Set GHL_BOOKING_WEBHOOK_URL to *also* forward to a GHL workflow (off by default).

const upsertGhlContact = require("./_ghl-contact");
const { runDispatch } = require("./dispatch");
const FORWARD_WEBHOOK = process.env.GHL_BOOKING_WEBHOOK_URL || ""; // optional escape hatch

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

  // 1) Upsert GHL contact (idempotent by email/phone) — dispatch books against it.
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

  // 2) Run the dispatch engine directly (same logic the n8n flow implemented):
  //    memory → reps → geocode → distance → nearest free rep at the chosen slot
  //    → book → confirmation email → memory save → Slack → dispatch_logs.
  const days = Array.isArray(b.available_days) ? b.available_days.join(",") : String(b.available_days || "");
  const windows = Array.isArray(b.best_time_windows) ? b.best_time_windows[0] : String(b.best_time_windows || "");
  const dispatchPayload = {
    body: {
      contact_id: contactId || b.contact_id || "",
      first_name: firstName,
      last_name: lastName,
      email,
      phone,
      full_address: String(b.address_full || "").trim(),
      PreferredDays: days,
      timewindow: windows,
      preferred_date: b.preferred_date || "",
      selected_slot: b.selected_slot || "",
      yard_size: b.area_size || "",
      source: "Website — Direct Booking Form",
    },
  };

  let dispatch = null, dispatchErr = null;
  try {
    dispatch = await runDispatch(dispatchPayload);
  } catch (e) { dispatchErr = String(e.message || e); console.error("[book] dispatch failed:", dispatchErr); }

  // 3) Optional forward to a GHL workflow (only if explicitly configured).
  let webhookOk = null;
  if (FORWARD_WEBHOOK) {
    try {
      const r = await fetch(FORWARD_WEBHOOK, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...b, contact_id: contactId || b.contact_id, dispatch_status: dispatch && dispatch.status }),
      });
      webhookOk = r.ok;
    } catch (e) { webhookOk = false; console.error("[book] webhook forward failed:", String(e.message || e)); }
  }

  console.log("[book-audit] " + JSON.stringify({
    ts: new Date().toISOString(), lead: `${firstName} ${lastName}`.trim(), email, phone,
    ghl_contact_id: contactId, ghl_contact_new: isNewContact, ghl_error: contactErr,
    dispatch_status: dispatch && dispatch.status, dispatch_remarks: dispatch && dispatch.remarks, dispatch_error: dispatchErr,
    webhook_forwarded: webhookOk,
    preferred_date: b.preferred_date || null, selected_slot: b.selected_slot || null,
  }));

  // Succeed if we at least created the contact or completed a dispatch —
  // the team can follow up on anything the engine couldn't book.
  const dispatchOk = dispatch && dispatch.status && dispatch.status !== "error";
  if (!contactId && !dispatchOk) {
    res.status(502).json({ error: "Booking could not be sent. Please try again or call us." });
    return;
  }
  res.status(200).json({
    ok: true,
    contact_id: contactId,
    dispatch_status: dispatch ? dispatch.status : "error",
    remarks: dispatch ? dispatch.remarks : dispatchErr,
  });
};
