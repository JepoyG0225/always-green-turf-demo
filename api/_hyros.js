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
  // HYROS's gateway returns intermittent 502/504s; retry once so a brief blip
  // doesn't drop a lead. Each attempt is time-bounded so a HYROS outage can't
  // stall the lead form — the lead is already saved to GHL either way.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const TIMEOUT = Number(process.env.HYROS_TIMEOUT_MS || 3000);
  let last = "unknown";
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
      const r = await fetch(ENDPOINT, { method: "POST", signal: ctrl.signal, headers: { "API-Key": HYROS_KEY, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.result === "OK") return { ok: true, requestId: d.request_id, attempts: attempt + 1 };
      last = `HYROS ${r.status}`;
      if (r.status < 500) return { ok: false, error: last }; // 4xx = don't retry
    } catch (e) { last = e.name === "AbortError" ? `timeout after ${TIMEOUT}ms` : String(e.message || e); }
    finally { clearTimeout(t); }
    if (attempt < 1) await sleep(300);
  }
  return { ok: false, error: last, retried: true };
}

module.exports = { trackLead, clientIp, splitName };
