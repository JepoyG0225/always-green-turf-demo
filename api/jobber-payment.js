// Jobber "PAYMENT_CREATE" webhook → apply the payment to the matching QBO invoice.
//
// Match key: customer + amount + open balance (Jobber and QBO are separate systems).
//   - exactly one open QBO invoice whose balance == the payment amount → apply
//   - only one open invoice at all (and amount <= its balance)          → apply
//   - no QBO customer at all → the client only ever existed in Jobber, so build
//     the missing QBO side from Jobber (customer + project + invoice from the
//     paid Jobber invoice's line items) and apply the payment to it
//   - anything ambiguous / no match                                     → NO auto-apply, Slack for review
//
// Dry run: POST ?dryRun=1 (or { "dryRun": true, "paymentId": "<jobber id>" }).
// Every step is recorded via _runlog into workflow_runs (execution viewer).

const newRun = require("./_runlog");
const qbo = require("./_qbo");
const jobber = require("./_jobber");
const { isPublished } = require("./_workflow-config");
const { mirrorToQbo } = require("./_jobber-invoice");

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_CHANNEL = process.env.SLACK_PAYMENTS_CHANNEL || "C096A9CR62Y"; // #workflow-testing

async function readRaw(req) {
  try { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks).toString("utf8"); }
  catch { return ""; }
}
const cents = (n) => Math.round(Number(n) * 100);

// Which Jobber invoice a payment belongs to: the allocation Jobber recorded
// itself, else the client's single invoice / the one whose total or balance is
// the amount paid. Anything less certain returns null — nothing gets rebuilt on
// a guess.
function jobberInvoiceFor(pay, amount) {
  const allocated = (((pay.allocations || {}).nodes) || []).map((a) => a.invoice).filter(Boolean);
  if (allocated.length) return allocated.length === 1 ? allocated[0] : null; // split across invoices — a human decides
  const invs = ((((pay.client || {}).invoices || {}).nodes) || []);
  const amt = cents(amount);
  const exact = invs.filter((i) => cents((i.amounts || {}).total) === amt || cents((i.amounts || {}).invoiceBalance) === amt);
  if (exact.length === 1) return exact[0];
  if (invs.length === 1) return invs[0];
  return null;
}

// A deposit arrives at signing, but the QBO customer and project are only ever
// created by the Jobber "job created" webhook. If nobody has converted the
// approved quote into a job yet, do it here so the QBO side exists and the
// deposit has somewhere to land when the job is closed and invoiced.
async function ensureJobForDeposit(run, jat, deposit, dryRun) {
  const existing = ((deposit.jobs && deposit.jobs.nodes) || [])[0];
  if (existing) {
    run.info("Quote already has a job", { quote: deposit.quoteNumber, job: existing.jobNumber });
    return { job: { id: existing.id, jobNumber: existing.jobNumber, created: false } };
  }
  if (dryRun) return { jobError: `DRY RUN — would create a job from quote #${deposit.quoteNumber}.` };
  try {
    const job = await run.step("Create Jobber job from quote", { quote: deposit.quoteNumber, quoteId: deposit.id }, () =>
      jobber.createJobFromQuote(jat, deposit));
    // Jobber's JOB_CREATE webhook will fire too, but run it here so the QBO
    // customer + project exist by the time this payment is reported.
    const qbo = await run.step("Create QBO customer + project", { jobId: job.id }, () =>
      require("./_jobber-job").run({ jobId: job.id }));
    return { job: { id: job.id, jobNumber: job.jobNumber, created: true }, qboCustomer: qbo && qbo.customerId, qboProject: qbo && qbo.projectId };
  } catch (e) {
    // The deposit is still safely held on the quote — report and move on.
    const msg = String(e.message || e);
    run.info("Could not create the job", { error: msg });
    return { jobError: `Could not create the job automatically: ${msg}` };
  }
}

async function notifySlack(text) {
  if (!SLACK_TOKEN) return;
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST", headers: { Authorization: `Bearer ${SLACK_TOKEN}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: SLACK_CHANNEL, text }),
  }).catch(() => {});
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  const rawStr = await readRaw(req);
  let body; try { body = JSON.parse(rawStr || "{}"); } catch { body = {}; }

  const dryRun = (req.query && req.query.dryRun === "1") || body.dryRun === true;
  const sig = req.headers["x-jobber-hmac-sha256"];
  const verified = jobber.verifyHmac(rawStr, sig);
  if (process.env.JOBBER_VERIFY_HMAC === "true" && !verified && !dryRun) { res.status(401).json({ error: "bad signature" }); return; }

  const ev = (body.data && body.data.webHookEvent) || body.webHookEvent || {};
  const topic = ev.topic || body.topic || "";
  const paymentId = ev.itemId || body.itemId || body.paymentId || "";

  // Jobber posts every subscribed topic to this one app webhook URL — route by topic.
  const T = String(topic).toUpperCase();
  if (T.startsWith("JOB")) {
    try { res.status(200).json(await require("./_jobber-job").run({ jobId: paymentId, dryRun })); }
    catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
    return;
  }
  if (T.startsWith("INVOICE")) {
    try { res.status(200).json(await require("./_jobber-invoice").run({ invoiceId: paymentId, dryRun })); }
    catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
    return;
  }

  const run = newRun("jobber-payment", { topic, paymentId, dryRun, verified });
  if (topic && !/payment/i.test(topic)) { run.info("Ignored topic", { topic }); await run.finish("skipped", `Ignored ${topic}`); res.status(200).json({ ok: true, ignored: topic }); return; }
  if (!paymentId) { await run.finish("error", "no payment id"); res.status(400).json({ error: "no payment id" }); return; }
  if (!dryRun && !(await isPublished("jobber-payment"))) { run.info("Workflow unpublished — skipped", {}); await run.finish("skipped", "Workflow is unpublished"); res.status(200).json({ ok: true, skipped: "unpublished" }); return; }

  const out = { status: "review", applied: false, dryRun, paymentId };
  try {
    // 1) Jobber payment → amount + client
    let jat;
    const pay = await run.step("Fetch Jobber payment", { paymentId }, async () => {
      jat = await jobber.accessToken();
      const p = await jobber.getPayment(jat, paymentId);
      if (!p) throw new Error("payment not found in Jobber");
      return p;
    });
    const amount = Number(pay.amount);
    const cl = pay.client || {};
    const name = [cl.firstName, cl.lastName].filter(Boolean).join(" ").trim();
    out.customer = cl.companyName || name || "(unknown)";
    out.email = cl.email || null; out.amount = amount;

    // A deposit paid against an approved quote — Jobber reports it as unallocated
    // until the job is invoiced, so it can never match an invoice.
    const deposit = ((cl.quotes && cl.quotes.nodes) || [])
      .filter((q) => cents(q.depositAmountUnallocated) >= cents(amount))
      .sort((a, b) => cents(a.depositAmountUnallocated) - cents(b.depositAmountUnallocated))[0] || null;
    if (deposit) run.info("Unallocated quote deposit found", { quote: deposit.quoteNumber, unallocated: deposit.depositAmountUnallocated });

    // 2) QBO customer(s) + open invoices
    const at = await run.step("QBO auth", {}, () => qbo.accessToken());
    const rlm = await qbo.realm();
    const custs = await run.step("Find QBO customer(s)", { email: cl.email, name, company: cl.companyName }, () => qbo.findCustomers(at, rlm, { email: cl.email, name, company: cl.companyName }));
    if (!custs.length) {
      // The client only ever existed in Jobber (the job/invoice workflows never
      // ran for it), so there is nothing in QBO to match against. Rebuild that
      // side from Jobber rather than parking the payment for a human: customer +
      // project + the invoice's line items, then apply the payment to it.
      //
      // A deposit against a quote is the one thing we must not rebuild: nothing
      // is invoiced yet in either system, so there are no line items to mirror
      // and the client's other invoices have nothing to do with this money.
      const jinv = deposit ? null : jobberInvoiceFor(pay, amount);
      run.info("No customer match", { customer: out.customer, quoteDeposit: deposit ? deposit.quoteNumber : null, jobberInvoice: jinv ? jinv.invoiceNumber : null });
      if (deposit) {
        out.status = "deposit_held";
        out.deposit = { quote: deposit.quoteNumber, quoteTotal: deposit.amounts && deposit.amounts.total, unallocated: deposit.depositAmountUnallocated };
        Object.assign(out, await ensureJobForDeposit(run, jat, deposit, dryRun));
        out.remarks = `Deposit of $${amount} on quote #${deposit.quoteNumber}${out.job ? ` — job #${out.job.jobNumber} ${out.job.created ? "created" : "already existed"}, so ${out.customer} now has a QBO customer + project. The deposit stays held until the job is closed and invoiced, then it is applied to that invoice.` : ` — held for ${out.customer}. ${out.jobError || "No job yet, so nothing to apply it to."}`}`;
      } else if (!jinv) {
        out.remarks = `No QBO customer found for ${out.customer}${cl.email ? " <" + cl.email + ">" : ""}, and no single Jobber invoice to rebuild it from. Needs review.`;
      } else if (dryRun) {
        out.status = "dry_run";
        out.match = { jobberInvoice: jinv.invoiceNumber };
        out.remarks = `DRY RUN — would create QBO customer "${out.customer}" + project, mirror Jobber invoice #${jinv.invoiceNumber}, and apply $${amount} to it.`;
      } else {
        const m = await mirrorToQbo(run, { at: jat, qat: at, rlm, invoiceId: jinv.id });
        // A re-fired webhook finds the invoice already mirrored and settled —
        // paying it a second time would leave the customer in credit.
        if (m.existed && cents(m.qboInv.Balance) <= 0) {
          out.status = "already_applied";
          out.match = { invoice: (m.qboNumber || m.qboInv.DocNumber), jobberInvoice: m.inv.invoiceNumber };
          out.remarks = `QBO invoice #${(m.qboNumber || m.qboInv.DocNumber)} (Jobber #${m.inv.invoiceNumber}) is already settled — payment not applied again.`;
        } else {
          const p = await run.step("Apply payment in QBO", { customerRef: m.project.Id, amount, invoiceId: m.qboInv.Id }, () =>
            qbo.createPayment(at, rlm, { customerId: m.project.Id, amount, invoiceId: m.qboInv.Id }));
          const remaining = Number((Number(m.qboInv.Balance != null ? m.qboInv.Balance : m.jobberTotal) - amount).toFixed(2));
          out.status = "backfilled"; out.applied = true;
          out.paymentType = remaining > 0 ? "partial" : "full";
          out.match = { invoice: (m.qboNumber || m.qboInv.DocNumber), qboInvoiceId: m.qboInv.Id, qboCustomerId: m.customer.Id, qboProjectId: m.project.Id, jobberInvoice: m.inv.invoiceNumber, qboPaymentId: p.Id, invoiceTotal: m.jobberTotal, remaining, invoiceExisted: m.existed };
          out.remarks = `${m.existed ? "Reused the already-mirrored" : "Created QBO customer + project and mirrored Jobber"} invoice #${m.inv.invoiceNumber} as QBO invoice #${(m.qboNumber || m.qboInv.DocNumber)} ($${m.jobberTotal}), then applied $${amount}` +
            (remaining > 0 ? `; $${remaining} still outstanding.` : ", paid in full.") + ` QBO payment #${p.Id}.`;
        }
      }
    } else {
      const invs = await run.step("Open invoices (customer + projects)", { customerIds: custs.map((c) => c.Id) }, () => qbo.openInvoices(at, rlm, custs.map((c) => c.Id)));
      const decision = await run.step("Match decision", { amount, openInvoices: invs.map((i) => ({ inv: i.DocNumber, balance: Number(i.Balance) })) }, async () => {
        const exact = invs.filter((i) => cents(i.Balance) === cents(amount));
        if (exact.length === 1) return { target: exact[0], reason: "exact amount match" };
        if (invs.length === 1 && cents(amount) <= cents(invs[0].Balance)) return { target: invs[0], reason: "only open invoice" };
        return { target: null, reason: invs.length === 0 ? "no open invoices" : "ambiguous" };
      });
      const target = decision.target;
      if (!target && decision.reason === "no open invoices" && deposit) {
        // Deposit paid against a quote. There is no invoice yet on either side,
        // so the money can't be applied — but the job can be started, and the
        // Job Closed workflow picks the deposit up from the quote and applies it
        // to the invoice it creates.
        out.status = "deposit_held";
        out.deposit = { quote: deposit.quoteNumber, quoteTotal: deposit.amounts && deposit.amounts.total, unallocated: deposit.depositAmountUnallocated };
        Object.assign(out, await ensureJobForDeposit(run, jat, deposit, dryRun));
        out.remarks = `Deposit of $${amount} on quote #${deposit.quoteNumber} — nothing invoiced yet, so it is held on the quote` +
          (out.job ? `; job #${out.job.jobNumber} ${out.job.created ? "created from the quote" : "already exists"}.` : `. ${out.jobError || ""}`) +
          " It is applied when the job is closed and invoiced.";
      } else if (!target) {
        out.remarks = decision.reason === "no open invoices"
          ? `${out.customer} has no open QBO invoices and no matching quote deposit — nothing to apply to. Needs review.`
          : `Ambiguous — ${invs.length} open invoices, no single match for $${amount}. Needs review.`;
      } else if (dryRun) {
        out.status = "dry_run";
        out.match = { invoice: target.DocNumber, invoiceId: target.Id, project: target.CustomerRef.name, balance: Number(target.Balance), reason: decision.reason };
        out.remarks = `DRY RUN — would apply $${amount} to invoice #${target.DocNumber} (${target.CustomerRef.name}) — ${decision.reason}.`;
        run.info("Dry run — not applied", out.match);
      } else {
        const p = await run.step("Apply payment in QBO", { customerRef: target.CustomerRef.value, amount, invoiceId: target.Id }, () => qbo.createPayment(at, rlm, { customerId: target.CustomerRef.value, amount, invoiceId: target.Id }));
        const remaining = Number((Number(target.Balance) - amount).toFixed(2));
        out.status = "applied"; out.applied = true;
        out.paymentType = remaining > 0 ? "partial" : "full";
        out.match = { invoice: target.DocNumber, qboPaymentId: p.Id, reason: decision.reason, invoiceBalance: Number(target.Balance), remaining };
        out.remarks = remaining > 0
          ? `Partial payment — applied $${amount} to QBO invoice #${target.DocNumber}; $${remaining} still outstanding. QBO payment #${p.Id}.`
          : `Paid in full — applied $${amount} to QBO invoice #${target.DocNumber}, now settled. QBO payment #${p.Id}.`;
      }
    }
  } catch (e) { out.status = "error"; out.remarks = String(e.message || e); }

  await run.step("Notify Slack", { channel: SLACK_CHANNEL }, async () => {
    // Deposits, invoice payments and problems are three different things to a
    // reader — give each its own headline rather than one generic "Payment".
    let icon = "👀", title = "Payment needs review";
    if (out.status === "deposit_held") { icon = "🏦"; title = "Deposit received"; }
    else if (out.status === "applied") { icon = out.paymentType === "partial" ? "💵" : "✅"; title = out.paymentType === "partial" ? "Partial payment applied" : "Payment applied — invoice paid in full"; }
    else if (out.status === "backfilled") { icon = "🆕"; title = `Customer + invoice created in QBO — payment applied${out.paymentType === "partial" ? " (partial)" : ""}`; }
    else if (out.status === "already_applied") { icon = "↩️"; title = "Payment already applied"; }
    else if (out.status === "dry_run") { icon = "🧪"; title = "Payment (dry run)"; }
    else if (out.status === "error") { icon = "⚠️"; title = "Payment failed"; }

    const lines = [
      `${icon} *${title}* ${dryRun ? "_(dry run)_" : ""}`,
      `*Customer:* ${out.customer || "—"}${out.email ? " <" + out.email + ">" : ""}`,
      `*Amount:* $${out.amount != null ? out.amount : "—"}`,
    ];
    if (out.status === "deposit_held") {
      lines.push(`*Quote:* #${out.deposit.quote}${out.deposit.quoteTotal != null ? ` ($${out.deposit.quoteTotal})` : ""}`);
      if (out.job) lines.push(`*Job:* #${out.job.jobNumber} ${out.job.created ? "created from the quote" : "already existed"}${out.qboProject ? ` — QBO customer + project ready` : ""}`);
      else if (out.jobError) lines.push(`*Job:* ⚠️ ${out.jobError}`);
      lines.push("*Status:* Nothing invoiced yet — deposit held on the quote.");
      lines.push("_It will be applied automatically when the job is closed and invoiced._");
    } else if (out.status === "applied") {
      lines.push(`*Invoice:* #${out.match.invoice}${out.paymentType === "partial" ? ` — $${out.match.remaining} still outstanding` : " — settled"}`);
      lines.push(`*Matched by:* ${out.match.reason}`);
    } else if (out.status === "backfilled") {
      lines.push(`*Invoice:* QBO #${out.match.invoice} (Jobber #${out.match.jobberInvoice}, $${out.match.invoiceTotal})${out.paymentType === "partial" ? ` — $${out.match.remaining} still outstanding` : " — settled"}`);
      lines.push(`*Created:* customer + project${out.match.invoiceExisted ? "" : " + invoice"} from Jobber — this client had no QBO record.`);
    } else {
      lines.push(`*Result:* ${out.remarks || out.status}`);
    }
    lines.push(`*Jobber payment:* \`${paymentId}\`${verified || dryRun ? "" : "  ⚠ unverified signature"}`);
    await notifySlack(lines.join("\n"));
    return { sent: !!SLACK_TOKEN };
  });

  const finalStatus = out.status === "error" ? "error"
    : out.status === "applied" || out.status === "backfilled" ? "success"
    : out.status === "deposit_held" || out.status === "already_applied" ? "info"
    : out.status;
  await run.finish(finalStatus, out.remarks || out.status);
  res.status(out.status === "error" ? 500 : 200).json(out);
};
