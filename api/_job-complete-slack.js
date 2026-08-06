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

// Mirrors the Job Completed Form card the crew-form workflow posts, so both
// arrive in #job-complete looking like the same thing. The fields differ —
// these come from Jobber rather than the crew's form — but the shape is the
// same: header, divider, summary, a two-column field grid, divider.
function buildBlocks({ job, client, address, mention, photoCount, skipped }) {
  const dash = (v) => (v && String(v).trim()) || "—";
  return [
    { type: "header", text: { type: "plain_text", text: "Job Completed Form", emoji: true } },
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: `*Job:* #${job.jobNumber}${job.title ? ` — ${job.title}` : ""}\n*Customer:* ${dash(client.name)}` } },
    { type: "section", fields: [
      { type: "mrkdwn", text: `*Email:*\n${dash(client.email)}` },
      { type: "mrkdwn", text: `*Phone:*\n${dash(client.phone)}` },
      { type: "mrkdwn", text: `*Address:*\n${dash(address)}` },
      { type: "mrkdwn", text: `*Sales Rep:*\n${mention || "—"}` },
    ] },
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: `*Completed Project Photos* (${photoCount})${skipped ? ` — showing the first ${photoCount} of ${photoCount + skipped}` : ""}` } },
  ];
}

// A channel override arrives either as an id (C0…) or a name (#workflow-testing).
// files.completeUploadExternal only accepts an id, so names are resolved here
// rather than making the caller look one up.
async function resolveChannelId(nameOrId) {
  const v = String(nameOrId || "").trim();
  if (!v) return null;
  if (/^[CGD][A-Z0-9]{6,}$/.test(v)) return v;
  const want = v.replace(/^#/, "").toLowerCase();
  let cursor = "";
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({ limit: "1000", exclude_archived: "true", types: "public_channel,private_channel" });
    if (cursor) params.set("cursor", cursor);
    const r = await fetch(`https://slack.com/api/conversations.list?${params}`, { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } });
    const d = await r.json().catch(() => ({}));
    if (!d.ok) throw new Error(`conversations.list: ${d.error || r.status}`);
    const hit = (d.channels || []).find((c) => String(c.name).toLowerCase() === want);
    if (hit) return hit.id;
    cursor = (d.response_metadata && d.response_metadata.next_cursor) || "";
    if (!cursor) break;
  }
  throw new Error(`no Slack channel named "${v}" that the bot can see`);
}

// photos: [{ fileName, contentType, url }] straight off the job's notes.
// channel: optional override (id or #name) — used to send a test run somewhere
// other than #job-complete.
async function postJobComplete(log, { job, client, address, rep, photos, channel }) {
  if (!SLACK_TOKEN) return { posted: false, reason: "SLACK_BOT_TOKEN not set" };
  if (!photos.length) return { posted: false, reason: "no photos on the job notes — nothing posted" };

  let target = CHANNEL;
  if (channel) {
    try {
      target = await resolveChannelId(channel);
      log.info("Posting to an override channel", { requested: channel, channelId: target });
    } catch (e) {
      // Never silently fall back to #job-complete — a test posting to the real
      // channel is worse than a test that doesn't post at all.
      return { posted: false, reason: String(e.message || e) };
    }
  }

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

  // The card goes up first, then the photos are shared into its thread.
  // files.completeUploadExternal only accepts a plain-text initial_comment, so a
  // Block Kit card has to be its own message; threading the photos underneath
  // keeps the channel readable when several jobs close the same day.
  //
  // Photos are already uploaded by this point — the card is only posted once
  // there's something to hang under it.
  const card = await slack("chat.postMessage", {
    channel: target,
    text: `Job Completed — #${job.jobNumber}${client.name ? ` · ${client.name}` : ""}`,
    blocks: buildBlocks({ job, client, address, mention: mention.text, photoCount: uploaded.length, skipped }),
  });

  try {
    await slack("files.completeUploadExternal", { files: uploaded, channel_id: target, thread_ts: card.ts });
  } catch (e) {
    // The card is already in the channel; say so rather than reporting a clean
    // failure that would send someone looking for a message that's right there.
    return { posted: true, photos: 0, photosFailed: uploaded.length, skipped, repMentioned: mention.resolved, channel: target, ts: card.ts, reason: `card posted, photos failed to attach: ${String(e.message || e)}` };
  }
  return { posted: true, photos: uploaded.length, skipped, repMentioned: mention.resolved, channel: target, ts: card.ts };
}

module.exports = { postJobComplete, isPhoto };
