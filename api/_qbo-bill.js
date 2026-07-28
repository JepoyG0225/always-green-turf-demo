// Build a QuickBooks Bill from an approved subcontractor takeoff.
//
// Matches AGT's existing hand-entered sub bills: each confirmed labor line posts
// to Contractors – COGS (acct 9), tagged to the customer's project, NotBillable.
// A price override uses the sub's adjusted amount and carries their comment into
// the line description. The bill's DocNumber is the job number so it's traceable.
const qbo = require("./_qbo");

const AP_ACCOUNT = process.env.QBO_AP_ACCOUNT || "184";              // Accounts Payable (A/P)
const COGS_ACCOUNT = process.env.QBO_CONTRACTORS_COGS || "9";        // Contractors - COGS
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const money = (n) => Number(num(n, 0).toFixed(2));

// Only lines the sub confirmed count. A confirmed line bills at its override
// amount when the sub adjusted it, else the agreed line total.
function billableLines(takeoff) {
  const items = Array.isArray(takeoff.line_items) ? takeoff.line_items : [];
  return items
    .filter((li) => li.confirmed !== false)
    .map((li) => {
      const overridden = li.override_cost != null && li.override_cost !== "";
      const amount = money(overridden ? li.override_cost : (li.line_total != null ? li.line_total : num(li.agreed_cost) * num(li.qty, 1)));
      const parts = [li.name || "Labor"];
      if (li.unit || li.qty != null) parts.push(`(${num(li.qty, 1)}${li.unit ? " " + li.unit : ""})`);
      if (overridden && li.override_comment) parts.push(`— adjusted: ${li.override_comment}`);
      return { name: li.name, amount, description: parts.join(" ") };
    })
    .filter((l) => l.amount !== 0);
}

function buildBillBody(takeoff, opts) {
  const vendorId = (opts && opts.vendorId) || takeoff.qbo_vendor_id;
  const projectId = takeoff.project_qbo_id;
  if (!vendorId) throw new Error("subcontractor has no QBO vendor mapped");
  const lines = billableLines(takeoff);
  if (!lines.length) throw new Error("no confirmed line items to bill");

  const Line = lines.map((l) => ({
    DetailType: "AccountBasedExpenseLineDetail",
    Amount: l.amount,
    Description: l.description,
    AccountBasedExpenseLineDetail: {
      AccountRef: { value: COGS_ACCOUNT },
      BillableStatus: "NotBillable",
      ...(projectId ? { CustomerRef: { value: String(projectId) } } : {}),
    },
  }));
  const total = money(Line.reduce((s, l) => s + l.Amount, 0));
  const body = {
    VendorRef: { value: String(vendorId) },
    APAccountRef: { value: AP_ACCOUNT },
    Line,
    PrivateNote: `AGT job #${takeoff.job_number || "?"} — ${takeoff.client_name || ""} — sub takeoff ${takeoff.id}`,
    ...(takeoff.job_number ? { DocNumber: String(takeoff.job_number) } : {}),
  };
  return { body, total, lineCount: Line.length };
}

// Create the Bill in QBO. Returns { billId, docNumber, total }.
async function createBill(takeoff, opts) {
  const { body, total, lineCount } = buildBillBody(takeoff, opts);
  if (opts && opts.dryRun) return { dryRun: true, total, lineCount, body };
  const at = await qbo.accessToken();
  const rlm = await qbo.realm();
  const out = await qbo.apiPost(at, rlm, "bill", body);
  const bill = out.Bill;
  return { billId: bill.Id, docNumber: bill.DocNumber, total: money(bill.TotalAmt), lineCount };
}

module.exports = { createBill, buildBillBody, billableLines };
