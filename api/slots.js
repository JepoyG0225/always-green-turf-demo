// GHL calendar availability → open time windows for a given date.
// Reads the "Free In-Home Design Estimate" calendar's free-slots (which already
// excludes booked times) and reports which of the three windows still have room.
//
//   GET /api/slots?date=YYYY-MM-DD  ->  { date, windows: [{value,label,sub,available}] }

const CAL = process.env.GHL_CALENDAR_ID || "re4bFa1FkhiEVb4Autpz";
const TOKEN = process.env.GHL_API_TOKEN || "";

const WINDOWS = [
  { value: "9:00am-12:00pm", label: "Morning",   sub: "9am – 12pm", startH: 9,  endH: 12 },
  { value: "12:00pm-3:00pm", label: "Afternoon", sub: "12pm – 3pm", startH: 12, endH: 15 },
  { value: "3:00pm-6:00pm",  label: "Evening",   sub: "3pm – 6pm",  startH: 15, endH: 18 },
];

module.exports = async function handler(req, res) {
  const date = (req.query && req.query.date) || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.status(400).json({ error: "date=YYYY-MM-DD required" }); return; }
  if (!TOKEN) { res.status(500).json({ error: "GHL not configured (GHL_API_TOKEN missing)." }); return; }

  // America/Phoenix is UTC-7 (no DST) — bound the whole Phoenix day.
  const start = Date.parse(date + "T00:00:00-07:00");
  const end = start + 24 * 3600 * 1000;
  const url = `https://services.leadconnectorhq.com/calendars/${CAL}/free-slots?startDate=${start}&endDate=${end}&timezone=America/Phoenix`;

  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, Version: "2021-04-15", Accept: "application/json" } });
    if (!r.ok) { res.status(502).json({ error: `GHL ${r.status}` }); return; }
    const data = await r.json();
    const slots = (data[date] && data[date].slots) || [];
    // Each slot is an ISO string already in -07:00 (Phoenix local), e.g. "2026-07-03T09:30:00-07:00".
    const hours = slots.map((s) => parseInt(String(s).slice(11, 13), 10));
    const windows = WINDOWS.map((w) => ({
      value: w.value, label: w.label, sub: w.sub,
      available: hours.some((h) => h >= w.startH && h < w.endH),
    }));
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ date, windows });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
};
