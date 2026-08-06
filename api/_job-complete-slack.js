// Job marked complete in Jobber → post it to Slack #job-complete with the
// photos the installer attached to the job's notes, tagging the sales rep.
//
// Only posts when there are photos: a completed job without proof shouldn't
// look the same in the channel as one with it.
//
// Everything here is best effort. It runs after the invoice work in
// jobber-job-closed, and a Slack problem must never affect invoicing.

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const CHANNEL = process.env.SLACK_JOBCOMPLETE_CHANNEL || "C02M55MSRFB"; // #job-complete
const MAX_PHOTOS = Number(process.env.JOB_COMPLETE_MAX_PHOTOS || 10);

const IMAGE = /\.(jpe?g|png|gif|webp|heic|heif)$/i;
const isPhoto = (f) => /^image\//i.test(f.contentType || "") || IMAGE.test(f.fileName || "");

async function slack(method, body) {
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SLACK_TOKEN}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) throw new Error(`slack ${method}: ${d.error || r.status}`);
  return d;
}

// The rep is mentioned by Slack member id — a plain name doesn't notify anyone.
// Their Jobber email is the link; if it doesn't resolve we fall back to the name
// rather than dropping the rep from the message.
async function mentionFor(rep) {
  const email = rep && rep.email;
  const name = (rep && rep.name) || "";
  if (!email) return { text: name || "—", resolved: false, reason: "no email on the Jobber user" };
  try {
    const r = await fetch(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`, {
      headers: { Authorization: `Bearer ${SLACK_TOKEN}` },
    });
    const d = await r.json().catch(() => ({}));
    if (d.ok && d.user && d.user.id) return { text: `<@${d.user.id}>`, resolved: true };
    return { text: name || email, resolved: false, reason: d.error || "not found in Slack" };
  } catch (e) {
    return { text: name || email, resolved: false, reason: String(e.message || e) };
  }
}

// Slack's external upload flow: reserve a URL, PUT the bytes, then complete the
// upload into the channel. Uploading rather than linking keeps the photos alive
// in the message — Jobber's own attachment URLs expire.
async function uploadPhoto(file, bytes) {
  const params = new URLSearchParams({ filename: file.fileName || "photo.jpg", length: String(bytes.length) });
  const r = await fetch(`https://slack.com/api/files.getUploadURLExternal?${params}`, {
    headers: { Authorization: `Bearer ${SLACK_TOKEN}` },
  });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) throw new Error(`getUploadURLExternal: ${d.error || r.status}`);
  const put = await fetch(d.upload_url, { method: "POST", body: bytes });
  if (!put.ok) throw new Error(`upload ${put.status}`);
  return d.file_id;
}

function summary({ job, client, address, mention, photoCount, skipped }) {
  const lines = [
    `✅ *Job Completed* — #${job.jobNumber}${job.title ? ` · ${job.title}` : ""}`,
    `*Customer:* ${client.name || "—"}${client.email ? ` <${client.email}>` : ""}${client.phone ? ` · ${client.phone}` : ""}`,
  ];
  if (address) lines.push(`*Address:* ${address}`);
  lines.push(`*Sales rep:* ${mention}`);
  lines.push(`*Photos:* ${photoCount}${skipped ? ` (showing the first ${photoCount} of ${photoCount + skipped})` : ""}`);
  return lines.join("\n");
}

// photos: [{ fileName, contentType, url }] straight off the job's notes.
async function postJobComplete(log, { job, client, address, rep, photos }) {
  if (!SLACK_TOKEN) return { posted: false, reason: "SLACK_BOT_TOKEN not set" };
  if (!photos.length) return { posted: false, reason: "no photos on the job notes — nothing posted" };

  const take = photos.slice(0, MAX_PHOTOS);
  const skipped = photos.length - take.length;
  const mention = await mentionFor(rep);
  if (!mention.resolved) log.info("Sales rep not matched to a Slack user", { email: rep && rep.email, reason: mention.reason });

  const uploaded = [];
  for (const p of take) {
    try {
      const r = await fetch(p.url);
      if (!r.ok) { log.info("Photo download failed", { file: p.fileName, status: r.status }); continue; }
      const bytes = Buffer.from(await r.arrayBuffer());
      uploaded.push({ id: await uploadPhoto(p, bytes), title: p.fileName || "Completed photo" });
    } catch (e) { log.info("Photo upload failed", { file: p.fileName, error: String(e.message || e) }); }
  }
  if (!uploaded.length) return { posted: false, reason: "every photo failed to upload" };

  const d = await slack("files.completeUploadExternal", {
    files: uploaded,
    channel_id: CHANNEL,
    initial_comment: summary({ job, client, address, mention: mention.text, photoCount: uploaded.length, skipped }),
  });
  return { posted: true, photos: uploaded.length, skipped, repMentioned: mention.resolved, ts: d.files && d.files[0] && d.files[0].id };
}

module.exports = { postJobComplete, isPhoto };
