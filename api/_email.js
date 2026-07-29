// Thin Resend wrapper — same provider that sends the warranty auto-responses.
const RESEND_KEY = process.env.RESEND_API_KEY || "";

async function sendEmail({ to, subject, html, from, replyTo }) {
  if (!RESEND_KEY) throw new Error("RESEND_API_KEY not set");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: from || process.env.RESEND_FROM || "Always Green Turf <noreply@alwaysgreenturfaz.com>",
      to: Array.isArray(to) ? to : [to],
      subject, html, ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend ${res.status}: ${JSON.stringify(d).slice(0, 160)}`);
  return d;
}

module.exports = { sendEmail };
