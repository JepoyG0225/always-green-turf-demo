// Job Completed form → Slack (#job-complete).
// Ported from the n8n "Job Completed - Slack Integration" workflow (Slack only —
// the Google Sheets append was intentionally dropped).
// Photos are uploaded to imgbb client-side; this receives completed_photo_urls.

const newRun = require("./_runlog");
const { isPublished } = require("./_workflow-config");

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_CHANNEL = process.env.SLACK_JOBCOMPLETE_CHANNEL || "C02M55MSRFB"; // #job-complete

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = []; for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return {}; }
}
const clean = (v) => (v == null ? "" : String(v).trim());

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  const b = await readBody(req);
  const run = newRun("job-complete", b);
  try {
    if (!(await isPublished("job-complete"))) { run.info("Workflow unpublished — skipped", {}); await run.finish("skipped", "Workflow is unpublished"); res.status(200).json({ ok: true, skipped: "unpublished" }); return; }

    const crew = clean(b.crew_name);
    const job = clean(b.job_name);
    const startDate = clean(b.install_start_date);
    const endDate = clean(b.install_completion_date);
    const materials = clean(b.leftover_materials_amount);
    const pallets = clean(b.leftover_empty_pallets_on_site) || "0";
    const photos = (Array.isArray(b.completed_photo_urls) ? b.completed_photo_urls : []).map(clean).filter((u) => /^https?:\/\//i.test(u));
    if (!crew && !job) throw new Error("crew_name or job_name required");

    // 1) Slack — block message to #job-complete
    await run.step("Notify Slack (#job-complete)", { crew, job, photos: photos.length }, async () => {
      if (!SLACK_TOKEN) throw new Error("SLACK_BOT_TOKEN not set");
      const blocks = [
        { type: "header", text: { type: "plain_text", text: "Job Completed Form", emoji: true } },
        { type: "divider" },
        { type: "section", text: { type: "mrkdwn", text: `*Crew:* ${crew || "—"}\n*Job:* ${job || "—"}` } },
        { type: "section", fields: [
          { type: "mrkdwn", text: `*Install Start:*\n${startDate || "—"}` },
          { type: "mrkdwn", text: `*Install Completion:*\n${endDate || "—"}` },
          { type: "mrkdwn", text: `*Left Over Materials Amount:*\n${materials || "—"}` },
          { type: "mrkdwn", text: `*Empty Pallets On Site:*\n${pallets}` },
        ] },
        { type: "divider" },
        { type: "section", text: { type: "mrkdwn", text: `*Completed Project Photos* (${photos.length})` } },
        ...photos.slice(0, 10).map((u, i) => ({ type: "image", image_url: u, alt_text: `Completed Photo ${i + 1}` })),
      ];
      const r = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST", headers: { Authorization: `Bearer ${SLACK_TOKEN}`, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ channel: SLACK_CHANNEL, text: `Job Completed — ${job || crew}`, blocks }),
      });
      const d = await r.json().catch(() => ({}));
      if (!d.ok) throw new Error(`slack: ${d.error || r.status}`);
      return { ts: d.ts };
    });

    await run.finish("success", `Job "${job || crew}" — Slack sent, ${photos.length} photos`);
    res.status(200).json({ ok: true, job: job || crew, photos: photos.length });
  } catch (e) {
    await run.finish("error", String(e.message || e));
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
