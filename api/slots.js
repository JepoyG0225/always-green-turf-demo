// GHL calendar availability → specific open time slots for a given date.
// Reads the "Free In-Home Design Estimate" calendar's free-slots (booked times
// are already excluded) and returns the open slots within business hours.
//
//   GET /api/slots?date=YYYY-MM-DD  ->  { date, slots: [{ value, label }] }

const CAL = process.env.GHL_CALENDAR_ID || "re4bFa1FkhiEVb4Autpz";
const TOKEN = process.env.GHL_API_TOKEN || "";
const OPEN_HOUR = 8;   // 8:00 AM
const CLOSE_HOUR = 18; // 6:00 PM (last shown slot before this)

function label(iso) {
  const hh = parseInt(iso.slice(11, 13), 10);
  const mm = iso.slice(14, 16);
  const ap = hh < 12 ? "AM" : "PM";
  let h12 = hh % 12; if (h12 === 0) h12 = 12;
  return h12 + ":" + mm + " " + ap;
}

module.exports = async function handler(req, res) {
  const date = (req.query && req.query.date) || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.status(400).json({ error: "date=YYYY-MM-DD required" }); return; }
  if (!TOKEN) { res.status(500).json({ error: "GHL not configured (GHL_API_TOKEN missing)." }); return; }

  const start = Date.parse(date + "T00:00:00-07:00"); // America/Phoenix = UTC-7 (no DST)
  const end = start + 24 * 3600 * 1000;
  const url = `https://services.leadconnectorhq.com/calendars/${CAL}/free-slots?startDate=${start}&endDate=${end}&timezone=America/Phoenix`;

  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, Version: "2021-04-15", Accept: "application/json" } });
    if (!r.ok) { res.status(502).json({ error: `GHL ${r.status}` }); return; }
    const data = await r.json();
    const raw = (data[date] && data[date].slots) || [];
    // Slots are ISO strings already in -07:00 (Phoenix local), e.g. "2026-07-03T09:30:00-07:00".
    const slots = raw
      .filter((s) => { const h = parseInt(String(s).slice(11, 13), 10); return h >= OPEN_HOUR && h < CLOSE_HOUR; })
      .map((s) => ({ value: String(s), label: label(String(s)) }));
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ date, slots });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
};
