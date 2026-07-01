// Call-back request → Slack notification (Vercel serverless function, no deps).
// Posts to the same channel the n8n "Direct Booking" flow used (C0BAZDCT5K4)
// via chat.postMessage. The Slack bot token stays server-side (env var).

const SLACK_CHANNEL = process.env.SLACK_CHANNEL_ID || "C0BAZDCT5K4"; // "direct-booking-appt"

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

  const text =
    `📞 *New Call-Back Request*\n\n` +
    `*Name:* ${fullName}\n` +
    `*Phone:* ${phone}\n` +
    `*Source:* Website booking page — "Call me to schedule"`;

  const slack = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: SLACK_CHANNEL, text }),
  });
  const data = await slack.json();
  if (!data.ok) { res.status(502).json({ error: `Slack error: ${data.error}` }); return; }

  res.status(200).json({ ok: true });
};
