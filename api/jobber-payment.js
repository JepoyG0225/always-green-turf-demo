// Jobber "PAYMENT_CREATE" webhook → apply the payment to the matching QBO invoice.
//
// Match key: customer + amount + open balance (Jobber and QBO are separate systems).
//   - exactly one open QBO invoice whose balance == the payment amount → apply
//   - only one open invoice at all (and amount <= its balance)          → apply
//   - anything ambiguous / no match                                     → NO auto-apply, Slack for review
//
// Dry run: POST ?dryRun=1 (or { "dryRun": true, "paymentId": "<jobber id>" }) to see the
// match decision without creating a QBO payment.

const qbo = require("./_qbo");
const jobber = require("./_jobber");

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_CHANNEL = process.env.SLACK_PAYMENTS_CHANNEL || "C096A9CR62Y"; // #workflow-testing
const SUPA = process.env.SUPABASE_URL || "https://otgpzpepmurbydcghygb.supabase.co";
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

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

async function logRow(row) {
  if (!SUPA_KEY) return;
  await fetch(`${SUPA}/rest/v1/dispatch_logs`, {
    method: "POST", headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(row),
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

  // Jobber webhook shape: { data: { webHookEvent: { topic, itemId } } }. Also accept a direct paymentId for testing.
  const ev = (body.data && body.data.webHookEvent) || body.webHookEvent || {};
  const topic = ev.topic || body.topic || "";
  const paymentId = ev.itemId || body.itemId || body.paymentId || "";
  if (topic && !/payment/i.test(topic)) { res.status(200).json({ ok: true, ignored: topic }); return; }
  if (!paymentId) { res.status(400).json({ error: "no payment id" }); return; }

  const out = { status: "review", applied: false, dryRun, paymentId };
  try {
    // 1) Jobber payment → amount + client
    const jat = await jobber.accessToken();
    const pay = await jobber.getPayment(jat, paymentId);
    if (!pay) throw new Error("payment not found in Jobber");
    const amount = Number(pay.amount);
    const cl = pay.client || {};
    const name = [cl.firstName, cl.lastName].filter(Boolean).join(" ").trim();
    out.customer = cl.companyName || name || "(unknown)";
    out.email = cl.email || null;
    out.amount = amount;

    // 2) QBO customer → open invoices → decide
    const at = await qbo.accessToken();
    const rlm = await qbo.realm();
    const cust = await qbo.findCustomer(at, rlm, { email: cl.email, name, company: cl.companyName });
    if (!cust) {
      out.remarks = `No QBO customer found for ${out.customer}${cl.email ? " <" + cl.email + ">" : ""}. Needs review.`;
    } else {
      const invs = await qbo.openInvoices(at, rlm, cust.Id);
      const exact = invs.filter((i) => cents(i.Balance) === cents(amount));
      let target = null, reason = "";
      if (exact.length === 1) { target = exact[0]; reason = "exact amount match"; }
      else if (invs.length === 1 && cents(amount) <= cents(invs[0].Balance)) { target = invs[0]; reason = "only open invoice"; }

      if (!target) {
        out.remarks = invs.length === 0
          ? `${out.customer} has no open QBO invoices — nothing to apply to. Needs review.`
          : `Ambiguous — ${invs.length} open invoices, no single match for $${amount}. Needs review.`;
      } else if (dryRun) {
        out.status = "dry_run";
        out.match = { invoice: target.DocNumber, invoiceId: target.Id, balance: Number(target.Balance), reason };
        out.remarks = `DRY RUN — would apply $${amount} to invoice #${target.DocNumber} (${reason}).`;
      } else {
        const p = await qbo.createPayment(at, rlm, { customerId: cust.Id, amount, invoiceId: target.Id });
        out.status = "applied"; out.applied = true;
        out.match = { invoice: target.DocNumber, qboPaymentId: p.Id, reason };
        out.remarks = `Applied $${amount} to QBO invoice #${target.DocNumber} (${reason}). QBO payment #${p.Id}.`;
      }
    }
  } catch (e) { out.status = "error"; out.remarks = String(e.message || e); }

  const icon = out.status === "applied" ? "✅" : out.status === "dry_run" ? "🧪" : out.status === "error" ? "⚠️" : "👀";
  await notifySlack(
    `${icon} *Jobber → QBO Payment* ${dryRun ? "_(dry run)_" : ""}\n` +
    `*Customer:* ${out.customer || "—"}${out.email ? " <" + out.email + ">" : ""}\n` +
    `*Amount:* $${out.amount != null ? out.amount : "—"}\n` +
    `*Result:* ${out.remarks || out.status}\n` +
    `*Jobber payment:* \`${paymentId}\`${verified ? "" : dryRun ? "" : "  ⚠ unverified signature"}`
  );
  await logRow({
    status: "jobber_payment",
    lead_name: out.customer, lead_email: out.email,
    remarks: (dryRun ? "[dry run] " : "") + (out.remarks || out.status),
    raw_payload: { paymentId, amount: out.amount, match: out.match || null, result: out.status, verified },
  });

  res.status(out.status === "error" ? 500 : 200).json(out);
};
