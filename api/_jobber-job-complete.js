// Jobber job completed → post the installer's photos to Slack #job-complete,
// with the customer, the address and the sales rep tagged.
//
// Its own workflow on purpose. Whether the crew's photos reach the channel has
// nothing to do with invoicing, and running it inside the invoice workflow gave
// it one shared publish switch, no run log of its own, and no way to retry the
// post without re-running the billing. Separated, it can be turned on, off and
// retried by itself.
//
// Only posts when the job actually has photos: a completed job without proof
// shouldn't look the same in the channel as one with it.
const newRun = require("./_runlog");
const jobber = require("./_jobber");
const { isPublished } = require("./_workflow-config");
const { jobberGql } = require("./_jobber-job");
const { postJobComplete, isPhoto } = require("./_job-complete-slack");

// The completion photos the installer attached to the job's notes, plus the rep
// and customer details for the Slack post.
//
// Asked for tolerantly: the notes/attachment shape is the part of Jobber's
// schema I'm least sure of. Two shapes are tried — attachments hanging off each
// note, and a flat list on the job — and whichever answers is used.
const COMPLETION_QUERIES = [
  `query($id:EncodedId!){ job(id:$id){ jobNumber title
     salesperson { name { full } email { raw } }
     client { name emails { address } phones { friendly } }
     property { address { street1 street2 city province postalCode } }
     notes(first: 50){ nodes { ... on JobNote { id message createdAt
       fileAttachments(first: 25){ nodes { id fileName contentType url } } } } } } }`,
  `query($id:EncodedId!){ job(id:$id){ jobNumber title
     salesperson { name { full } email { raw } }
     client { name emails { address } phones { friendly } }
     property { address { street1 street2 city province postalCode } }
     noteAttachments(first: 50){ nodes { id fileName contentType url } } } }`,
];

async function completionDetails(at, jobId, log) {
  for (const [i, q] of COMPLETION_QUERIES.entries()) {
    try {
      const d = await jobberGql(at, q, { id: jobId });
      const j = d.job;
      if (!j) continue;
      const fromNotes = ((j.notes && j.notes.nodes) || [])
        .flatMap((n) => ((n && n.fileAttachments && n.fileAttachments.nodes) || []));
      const flat = (j.noteAttachments && j.noteAttachments.nodes) || [];
      const files = [...fromNotes, ...flat].filter(Boolean);
      const a = (j.property && j.property.address) || {};
      return {
        job: { jobNumber: j.jobNumber, title: j.title },
        rep: j.salesperson ? { name: j.salesperson.name && j.salesperson.name.full, email: j.salesperson.email && j.salesperson.email.raw } : null,
        client: {
          name: j.client && j.client.name,
          email: j.client && j.client.emails && j.client.emails[0] && j.client.emails[0].address,
          phone: j.client && j.client.phones && j.client.phones[0] && j.client.phones[0].friendly,
        },
        address: [a.street1, a.street2, a.city, a.province, a.postalCode].filter(Boolean).join(", "),
        photos: files.filter(isPhoto).map((f) => ({ fileName: f.fileName, contentType: f.contentType, url: f.url })),
        shape: i,
      };
    } catch (e) { log.info(`Job notes shape ${i} unavailable`, { error: String(e.message || e).slice(0, 160) }); }
  }
  return null;
}

// dryRun still posts — the Slack message IS what's being tested. `channel`
// sends it somewhere other than #job-complete, and a dry run skips the publish
// check so a workflow can be tested before it's switched on.
async function run({ jobId, dryRun, channel }) {
  const log = newRun("jobber-job-complete", { jobId, dryRun, channel });
  try {
    if (!dryRun && !(await isPublished("jobber-job-complete"))) {
      log.info("Unpublished — skipped", {});
      await log.finish("skipped", "Workflow is unpublished");
      return { ok: true, skipped: "unpublished" };
    }
    if (!jobId) throw new Error("no job id");

    const at = await log.step("Jobber auth", {}, () => jobber.accessToken());
    const details = await log.step("Read the job's notes + photos", { jobId }, async () => {
      const d = await completionDetails(at, jobId, log);
      if (!d) throw new Error("could not read the job's notes");
      return d;
    });

    const jobNumber = details.job.jobNumber;
    const clientName = details.client.name || "";
    if (!details.photos.length) {
      log.info("No photos on the job's notes", { jobNumber });
      await log.finish("skipped", `Job #${jobNumber} (${clientName}) has no photos attached — nothing posted`);
      return { ok: true, skipped: "no-photos", jobNumber, clientName };
    }

    const post = await log.step("Post to Slack", { photos: details.photos.length, rep: details.rep && details.rep.email, channel: channel || "#job-complete", dryRun: !!dryRun }, () =>
      postJobComplete(log, { job: details.job, client: details.client, address: details.address, rep: details.rep, photos: details.photos, channel }));

    if (!post.posted) {
      await log.finish("error", `Job #${jobNumber} (${clientName}) — not posted: ${post.reason}`);
      return { ok: false, jobNumber, clientName, photosFound: details.photos.length, slack: post };
    }
    await log.finish("success", `Job #${jobNumber} (${clientName}) → Slack, ${post.photos} photo(s)${post.repMentioned ? ", rep tagged" : ""}${channel ? ` [test → ${channel}]` : ""}`);
    return { ok: true, jobNumber, clientName, photosFound: details.photos.length, slack: post };
  } catch (e) { await log.finish("error", String(e.message || e)); throw e; }
}

module.exports = { run, completionDetails };
