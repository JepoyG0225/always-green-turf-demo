// Jobber "PAYMENT_CREATE" webhook → apply the payment to the matching QBO invoice.
//
// Match key: customer + amount + open balance (Jobber and QBO are separate systems).
//   - exactly one open QBO invoice whose balance == the payment amount → apply
//   - only one open invoice at all (and amount <= its balance)          → apply
//   - anything ambiguous / no match                                     → NO auto-apply, Slack for review
//
// Dry run: POST ?dryRun=1 (or { "dryRun": true, "paymentId": "<jobber id>" }).
// Every step is recorded via _runlog into workflow_runs (execution viewer).

const newRun = require("./_runlog");
const qbo = require("./_qbo");
const jobber = require("./_jobber");

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_CHANNEL = process.env.SLACK_PAYMENTS_CHANNEL || "C096A9CR62Y"; // #workflow-testing

async function readRaw(req) {
  try { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks).toString("utf8"); }
  catch { return ""; }
}
const cents = (n) => Math.round(Number(n) * 100);

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

  const run = newRun("jobber-payment", { topic, paymentId, dryRun, verified });
  if (topic && !/payment/i.test(topic)) { run.info("Ignored topic", { topic }); await run.finish("skipped", `Ignored ${topic}`); res.status(200).json({ ok: true, ignored: topic }); return; }
  if (!paymentId) { await run.finish("error", "no payment id"); res.status(400).json({ error: "no payment id" }); return; }

  const out = { status: "review", applied: false, dryRun, paymentId };
  try {
    // 1) Jobber payment → amount + client
    const pay = await run.step("Fetch Jobber payment", { paymentId }, async () => {
      const jat = await jobber.accessToken();
      const p = await jobber.getPayment(jat, paymentId);
      if (!p) throw new Error("payment not found in Jobber");
      return p;
    });
    const amount = Number(pay.amount);
    const cl = pay.client || {};
    const name = [cl.firstName, cl.lastName].filter(Boolean).join(" ").trim();
    out.customer = cl.companyName || name || "(unknown)";
    out.email = cl.email || null; out.amount = amount;

    // 2) QBO customer(s) + open invoices
    const at = await run.step("QBO auth", {}, () => qbo.accessToken());
    const rlm = await qbo.realm();
    const custs = await run.step("Find QBO customer(s)", { email: cl.email, name, company: cl.companyName }, () => qbo.findCustomers(at, rlm, { email: cl.email, name, company: cl.companyName }));
    if (!custs.length) {
      out.remarks = `No QBO customer found for ${out.customer}${cl.email ? " <" + cl.email + ">" : ""}. Needs review.`;
      run.info("No customer match", { customer: out.customer });
    } else {
      const invs = await run.step("Open invoices (customer + projects)", { customerIds: custs.map((c) => c.Id) }, () => qbo.openInvoices(at, rlm, custs.map((c) => c.Id)));
      const decision = await run.step("Match decision", { amount, openInvoices: invs.map((i) => ({ inv: i.DocNumber, balance: Number(i.Balance) })) }, async () => {
        const exact = invs.filter((i) => cents(i.Balance) === cents(amount));
        if (exact.length === 1) return { target: exact[0], reason: "exact amount match" };
        if (invs.length === 1 && cents(amount) <= cents(invs[0].Balance)) return { target: invs[0], reason: "only open invoice" };
        return { target: null, reason: invs.length === 0 ? "no open invoices" : "ambiguous" };
      });
      const target = decision.target;
      if (!target) {
        out.remarks = decision.reason === "no open invoices"
          ? `${out.customer} has no open QBO invoices — nothing to apply to. Needs review.`
          : `Ambiguous — ${invs.length} open invoices, no single match for $${amount}. Needs review.`;
      } else if (dryRun) {
        out.status = "dry_run";
        out.match = { invoice: target.DocNumber, invoiceId: target.Id, project: target.CustomerRef.name, balance: Number(target.Balance), reason: decision.reason };
        out.remarks = `DRY RUN — would apply $${amount} to invoice #${target.DocNumber} (${target.CustomerRef.name}) — ${decision.reason}.`;
        run.info("Dry run — not applied", out.match);
      } else {
        const p = await run.step("Apply payment in QBO", { customerRef: target.CustomerRef.value, amount, invoiceId: target.Id }, () => qbo.createPayment(at, rlm, { customerId: target.CustomerRef.value, amount, invoiceId: target.Id }));
        out.status = "applied"; out.applied = true;
        out.match = { invoice: target.DocNumber, qboPaymentId: p.Id, reason: decision.reason };
        out.remarks = `Applied $${amount} to QBO invoice #${target.DocNumber} (${decision.reason}). QBO payment #${p.Id}.`;
      }
    }
  } catch (e) { out.status = "error"; out.remarks = String(e.message || e); }

  await run.step("Notify Slack", { channel: SLACK_CHANNEL }, async () => {
    const icon = out.status === "applied" ? "✅" : out.status === "dry_run" ? "🧪" : out.status === "error" ? "⚠️" : "👀";
    await notifySlack(
      `${icon} *Jobber → QBO Payment* ${dryRun ? "_(dry run)_" : ""}\n` +
      `*Customer:* ${out.customer || "—"}${out.email ? " <" + out.email + ">" : ""}\n*Amount:* $${out.amount != null ? out.amount : "—"}\n` +
      `*Result:* ${out.remarks || out.status}\n*Jobber payment:* \`${paymentId}\`${verified || dryRun ? "" : "  ⚠ unverified signature"}`);
    return { sent: !!SLACK_TOKEN };
  });

  await run.finish(out.status === "error" ? "error" : out.status === "applied" ? "success" : out.status, out.remarks || out.status);
  res.status(out.status === "error" ? 500 : 200).json(out);
};
