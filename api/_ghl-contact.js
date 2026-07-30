// Shared GHL contact upsert helper. Deduped server-side by email/phone.
// Returns { id, new }. Throws on non-2xx.
const TOKEN = process.env.GHL_API_TOKEN || "";
const LOC = process.env.GHL_LOCATION_ID || "dpp7zOnwhkHGWhn5lGRd";

module.exports = async function upsertGhlContact({
  firstName = "", lastName = "", email = "", phone = "",
  address1 = "", city = "", state = "", postalCode = "",
  tags = [], source = "",
}) {
  if (!TOKEN) throw new Error("GHL_API_TOKEN not set");
  const body = {
    locationId: LOC,
    firstName: firstName || undefined,
    lastName: lastName || undefined,
    email: email || undefined,
    phone: phone || undefined,
    address1: address1 || undefined,
    city: city || undefined,
    state: state || undefined,
    postalCode: postalCode || undefined,
    tags: tags.length ? tags : undefined,
    source: source || undefined,
  };
  const res = await fetch("https://services.leadconnectorhq.com/contacts/upsert", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, Version: "2021-07-28", "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GHL contact upsert ${res.status}: ${data.message || JSON.stringify(data).slice(0, 200)}`);
  return { id: data.contact && data.contact.id, new: !!data.new };
};

// Look up an existing GHL contact by email or phone. Returns the matching
// contact (exact email or last-10-digits phone) or null. Used as a guardrail so
// we can skip leads that already exist rather than upserting over them.
const digits10 = (s) => String(s || "").replace(/\D/g, "").slice(-10);
module.exports.findContact = async function findContact({ email = "", phone = "" }) {
  if (!TOKEN) throw new Error("GHL_API_TOKEN not set");
  const el = String(email || "").trim().toLowerCase();
  const pd = digits10(phone);
  for (const term of [email, phone].map((t) => String(t || "").trim()).filter(Boolean)) {
    const r = await fetch(`https://services.leadconnectorhq.com/contacts/?locationId=${LOC}&query=${encodeURIComponent(term)}&limit=10`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Version: "2021-07-28", Accept: "application/json" },
    });
    if (!r.ok) continue;
    const d = await r.json().catch(() => ({}));
    const hit = (d.contacts || []).find((c) =>
      (el && String(c.email || "").toLowerCase() === el) || (pd && digits10(c.phone) === pd));
    if (hit) return hit;
  }
  return null;
};
