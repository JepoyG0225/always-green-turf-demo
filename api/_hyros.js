// HYROS lead tracking — server-side. Every website lead is upserted into HYROS
// so it's captured for attribution even if the browser tracking script misses.
// HYROS resolves identity by email/phone and merges; passing the visitor's real
// IP (not our server's) strengthens the match to their tracked session.
//   POST https://api.hyros.com/v1/api/v1.0/leads   header: API-Key
const HYROS_KEY = process.env.HYROS_API_KEY || "";
const ENDPOINT = "https://api.hyros.com/v1/api/v1.0/leads";

// The visitor's IP as seen by Vercel (first hop in X-Forwarded-For).
function clientIp(req) {
  const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || req.headers["x-real-ip"] || null;
}

function splitName(full) {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || "", lastName: parts.slice(1).join(" ") };
}

// Upsert a lead into HYROS. Non-throwing by default — lead capture must never
// break because HYROS is down; returns a status object instead.
async function trackLead({ email, firstName, lastName, phone, ip, tags, source } = {}) {
  if (!HYROS_KEY) return { skipped: "HYROS_API_KEY not set" };
  email = (email || "").trim();
  phone = (phone || "").trim();
  if (!email && !phone) return { skipped: "no email or phone" };
  const body = {
    ...(email ? { email } : {}),
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {}),
    ...(phone ? { phoneNumbers: [phone] } : {}),
    ...(ip ? { ip } : {}),
    ...(source ? { source } : {}),
    ...(Array.isArray(tags) && tags.length ? { tags } : {}),
  };
  try {
    const r = await fetch(ENDPOINT, { method: "POST", headers: { "API-Key": HYROS_KEY, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.result !== "OK") return { ok: false, error: `HYROS ${r.status}: ${JSON.stringify(d).slice(0, 140)}` };
    return { ok: true, requestId: d.request_id };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

module.exports = { trackLead, clientIp, splitName };
