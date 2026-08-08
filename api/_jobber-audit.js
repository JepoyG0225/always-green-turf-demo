// Read-only diagnostic: where did a job's discount go?
//
// Answers the question the invoice workflow can't: the quote, the job and the
// invoice each hold line items AND their own amount totals, and a discount can
// live in either place. When a discount reaches the quote but not the invoice,
// this shows which of the three lost it.
//
// Makes no writes and no run-log entry. Resolving a job by its *number* (what
// staff see) rather than its encoded id is half the point — nobody has the
// encoded id to hand.
const jobber = require("./_jobber");
const { jobberGql } = require("./_jobber-job");

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const money = (n) => Number(num(n, 0).toFixed(2));

// Jobber's filter/search arguments vary by API version, so try the cheap
// targeted shapes first and fall back to paging recent jobs. The fallback is
// slow but always works, and this runs once per investigation.
const LOOKUPS = [
  { q: `query($n:Int!){ jobs(filter:{number:$n}, first:5){ nodes{ id jobNumber } } }`, vars: (n) => ({ n: Number(n) }) },
  { q: `query($n:String!){ jobs(searchTerm:$n, first:10){ nodes{ id jobNumber } } }`, vars: (n) => ({ n: String(n) }) },
];

async function resolveJobByNumber(at, jobNumber, log) {
  const want = Number(jobNumber);
  const info = (m, d) => { if (log && log.push) log.push({ step: m, ...d }); };

  for (const [i, l] of LOOKUPS.entries()) {
    try {
      const d = await jobberGql(at, l.q, l.vars(jobNumber));
      const hit = ((d.jobs && d.jobs.nodes) || []).find((j) => Number(j.jobNumber) === want);
      if (hit) { info(`lookup shape ${i} matched`, { id: hit.id }); return hit.id; }
      info(`lookup shape ${i} returned no match`, {});
    } catch (e) { info(`lookup shape ${i} unavailable`, { error: String(e.message || e).slice(0, 140) }); }
  }

  // Fallback: page recent jobs newest-first until the number turns up.
  let cursor = null;
  for (let page = 0; page < 12; page++) {
    const q = `query($after:String){ jobs(first:50, after:$after){ nodes{ id jobNumber } pageInfo{ hasNextPage endCursor } } }`;
    const d = await jobberGql(at, q, { after: cursor });
    const nodes = (d.jobs && d.jobs.nodes) || [];
    const hit = nodes.find((j) => Number(j.jobNumber) === want);
    if (hit) { info(`found by paging (page ${page + 1})`, { id: hit.id }); return hit.id; }
    const pi = (d.jobs && d.jobs.pageInfo) || {};
    if (!pi.hasNextPage) break;
    cursor = pi.endCursor;
  }
  throw new Error(`no Jobber job with number ${jobNumber}`);
}

// Quote, job and invoice side by side. Each is asked for tolerantly: a field
// missing in this API version must not lose the rest of the picture.
const JOB_Q = `query($id:EncodedId!){ job(id:$id){ id jobNumber title total invoicedTotal uninvoicedTotal
  client{ id name companyName firstName lastName }
  lineItems{ nodes{ id name quantity unitPrice totalPrice } }
  invoices(first:10){ nodes{ id invoiceNumber
    amounts{ subtotal discountAmount taxAmount depositAmount paymentsTotal invoiceBalance total }
    lineItems{ nodes{ name quantity unitPrice totalPrice } } } } } }`;

const QUOTE_QUERIES = [
  `query($id:EncodedId!){ job(id:$id){ quote{ id quoteNumber
     amounts{ subtotal discountAmount taxAmount total }
     lineItems{ nodes{ name quantity unitPrice totalPrice } } } } }`,
  `query($id:EncodedId!){ job(id:$id){ quote{ id quoteNumber
     discountAmount subtotal total
     lineItems{ nodes{ name quantity unitPrice totalPrice } } } } }`,
  `query($id:EncodedId!){ job(id:$id){ quote{ id quoteNumber
     lineItems{ nodes{ name quantity unitPrice totalPrice } } } } }`,
];

const looksLikeDiscount = (n) => /discount/i.test(String(n || ""));
const summarise = (nodes) =>
  (nodes || []).map((li) => ({
    name: li.name,
    qty: num(li.quantity, 1),
    unitPrice: money(li.unitPrice),
    total: li.totalPrice != null ? money(li.totalPrice) : money(num(li.unitPrice) * num(li.quantity, 1)),
    isDiscount: looksLikeDiscount(li.name) || num(li.unitPrice) < 0,
  }));

async function auditJob({ jobNumber, jobId }) {
  const trace = [];
  const at = await jobber.accessToken();
  const id = jobId || (await resolveJobByNumber(at, jobNumber, trace));

  const d = await jobberGql(at, JOB_Q, { id });
  const job = d.job;
  if (!job) throw new Error("job not found");

  // Quote — shape varies, take whichever answers.
  let quote = null;
  for (const [i, q] of QUOTE_QUERIES.entries()) {
    try {
      const qd = await jobberGql(at, q, { id });
      const qq = qd.job && qd.job.quote;
      if (qq) { quote = { ...qq, _shape: i }; break; }
      trace.push({ step: `quote shape ${i}: no quote on job` });
    } catch (e) { trace.push({ step: `quote shape ${i} unavailable`, error: String(e.message || e).slice(0, 140) }); }
  }

  const jobLines = summarise(job.lineItems && job.lineItems.nodes);
  const quoteLines = quote ? summarise(quote.lineItems && quote.lineItems.nodes) : [];
  const invoices = ((job.invoices && job.invoices.nodes) || []).map((inv) => ({
    invoiceNumber: inv.invoiceNumber,
    amounts: inv.amounts || {},
    lines: summarise(inv.lineItems && inv.lineItems.nodes),
  }));

  const qAmt = (quote && (quote.amounts || quote)) || {};
  const discount = {
    quote: {
      asLineItems: quoteLines.filter((l) => l.isDiscount),
      asAmount: money(qAmt.discountAmount),
    },
    job: { asLineItems: jobLines.filter((l) => l.isDiscount) },
    invoices: invoices.map((i) => ({
      invoiceNumber: i.invoiceNumber,
      asLineItems: i.lines.filter((l) => l.isDiscount),
      asAmount: money(i.amounts.discountAmount),
    })),
  };

  // Where it was lost.
  const onQuote = discount.quote.asLineItems.length > 0 || discount.quote.asAmount > 0;
  const onJob = discount.job.asLineItems.length > 0;
  const onInvoice = discount.invoices.some((i) => i.asLineItems.length > 0 || i.asAmount > 0);
  // Check the invoice FIRST. A discount can be absent from the job's line items
  // and still reach the invoice, because Jobber carries a quote-level discount
  // across on its own — so judging by the job alone reports a loss that didn't
  // happen. (It did exactly that on the first run of this tool.)
  let verdict;
  if (onInvoice)
    verdict = "Jobber is correct — the invoice carries the discount. Anything missing downstream was lost mirroring to QBO, not in Jobber.";
  else if (!onQuote) verdict = "No discount on the quote either — it was never applied upstream.";
  else if (discount.quote.asLineItems.length === 0 && discount.quote.asAmount > 0)
    verdict = "Quote holds the discount as a quote-level amount rather than a line item, and it did not reach the invoice.";
  else if (!onJob) verdict = "Discount is on the quote but not on the job's line items — lost at quote → job.";
  else verdict = "Discount is on the job's line items but not on the invoice — lost at job → invoice.";

  return {
    ok: true,
    jobId: id,
    jobNumber: job.jobNumber,
    title: job.title,
    client: (job.client && (job.client.companyName || job.client.name || [job.client.firstName, job.client.lastName].filter(Boolean).join(" "))) || null,
    totals: { job: money(job.total), invoiced: money(job.invoicedTotal), uninvoiced: money(job.uninvoicedTotal) },
    quote: quote ? { quoteNumber: quote.quoteNumber, amounts: quote.amounts || null, lineCount: quoteLines.length } : null,
    discount,
    verdict,
    lines: { quote: quoteLines, job: jobLines },
    invoices,
    trace,
  };
}

module.exports = { auditJob, resolveJobByNumber };
