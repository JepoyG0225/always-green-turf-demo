# Automating Vendor Payments — Plan

**Status:** awaiting approval · **Last updated:** 2026-08-06

After a job is completed, AGT pays two kinds of vendor:

1. **Subcontractors** (installers) — Phase 1, specified below
2. **Sales reps** (commission) — Phase 2, not yet specified

This document covers Phase 1 in full and states what's still needed to plan Phase 2.

---

## Phase 1 — Subcontractor payment

### The flow we're aiming for

> Job marked Completed → the sub receives a pre-populated form (job description +
> line-item costs from the labor takeoff) → they confirm each line, uncheck
> anything they didn't do, adjust a price only with a comment, and upload
> completion photos → submit → the bill lands in QuickBooks for review and
> payment.

Net effect: installers get paid as soon as the form is in, nobody chases subs for
invoices, and every bill is pre-validated against agreed pricing.

### Where we already are

More of this is built than it might appear. Mapping the spec line by line:

| Spec item | Status | Where |
|---|---|---|
| Pre-populated form: job description + line-item costs | **Partly** — builds correctly, but the cost-matching bridge is unreliable (see Gap 2) | `api/_sub-takeoff.js` |
| Review each line against agreed pricing | **Done** | `sub-takeoff.html` |
| Uncheck a line they didn't perform | **Done** | `sub-takeoff.html` |
| Adjust pricing only with a required comment | **Done** — enforced server-side, not just in the UI | `api/sub-takeoff.js` |
| Attach a backup image to *that specific line* | **Done** | `api/sub-takeoff.js` |
| Required photos of completed work | **Done** — submit is rejected without at least one | `api/sub-takeoff.js:103` |
| Those photos post to job-complete | **Done** — same Slack channel as the job-complete workflow | `api/sub-takeoff.js:13` |
| Fires automatically when the job is Completed | **Written, not committed** | see Gap 1 |
| Lands in QBO Bills for review and payment | **Different from spec** — see Decision A | `api/_qbo-bill.js` |
| Pay the installer as soon as the form is in | **Different from spec** — see Decision B | see Gap 3 |

The sub-facing form, the photo rules, the comment-gated price override, and the
QBO bill builder are all working. The gaps are the two ends of the pipe: what
starts it, and what the costs are pre-filled from.

---

### Gap 1 — Nothing starts the process

Today an admin pastes a Jobber job ID into `/admin/takeoffs` and clicks
Generate. Until someone does that, the sub hears nothing.

**Fix:** hook it to Jobber's `JOB_CLOSED` webhook, which already fires the
customer invoice and carries the job ID we need. The takeoff runs alongside the
invoice, never blocking it, and is idempotent on job ID so re-closing a job can't
produce a second form (and therefore a second bill).

> **Already written, uncommitted.** I built this before you asked for a plan.
> It's sitting in the working tree, deployed nowhere. Approve it and it's Step 1
> already done; say the word and I'll revert it and we start clean.

*Considered and rejected:* triggering off the crew's Job Completed form instead.
It only sends free-text crew and job names, no job ID, so it can't pull line
items — we'd be matching jobs by name.

---

### Gap 2 — Attaching costs to specs *(the real problem)*

This is the one you flagged, and it's the part most worth getting right.

**What happens now.** The form is built from the Jobber job's line items, and
each line's name is matched against the `labor_rates` rate card — exact name
first, then a prefix match. A match pre-fills the agreed cost and pre-checks the
line. **A miss produces a $0 line, unchecked.**

**Why it's fragile.** The original build joined on `arcsite_product_id` — the
commit calls it "the reliable bridge; name matching proved too weak." A later
commit moved the source from the ArcSite drawing to the Jobber job (correct — the
job reflects final scope and change orders), but in doing so fell back to name
matching. The `arcsite_product_id` column is still on the rate card, still
indexed, still copied onto each line — just no longer used to match.

So a Jobber line called "Base Prep" will not find a rate card item called "Ground
Preparation," and the sub gets a blank price to fill in themselves. That is the
opposite of pre-validated pricing.

**This gets worse with automation, not better.** Manual generation let an admin
eyeball the form before sending. Automatic sending removes that check — so Gap 2
must be closed in the same release as Gap 1, not after it.

Three fixes, in the order I'd do them:

**2a. Hold unmatched takeoffs instead of sending them.** If any line fails to
match the rate card, still create the takeoff, but don't email it. Park it in
`/admin/takeoffs` and notify the office to price it. This is what makes "every
bill is pre-validated against agreed pricing" a guarantee rather than a hope.
Small change; do it regardless of the other two.

**2b. Aliases on the rate card.** Add an `aliases` list to `labor_rates` so one
agreed rate answers to every name Jobber has used for it. The office fixes a miss
in seconds from `/admin/labor-rates`, and it stays fixed. Cheap and explicit.

**2c. Learn from corrections.** When someone prices a held line by hand, remember
that name → rate mapping so it matches itself next time. This is 2b with the
typing automated — worth building only once 2b is in and we can see which names
actually recur. **Not recommended for the first release.**

Recommendation: **2a + 2b now, 2c later if the held queue doesn't shrink.**

---

### Gap 3 — Two places the build differs from your spec

You picked both of these when I asked earlier, but your latest description
restates the original spec, so I'd rather re-confirm than guess.

#### Decision A — how the takeoff reaches QuickBooks

| | Spec as written | What's built |
|---|---|---|
| Route | Email the form to our unique QBO address | Create the Bill directly via the QBO API |
| Arrives as | An uncoded document in the receipt inbox | A Bill coded to Contractors–COGS (acct 9), tagged to the customer's project, DocNumber = job number |
| Still needs | Someone to key in the account, project, and amounts | Nothing — it's ready to pay |

The API route is already built and lands a *better* bill: fully coded, so it
posts to the right account and job with no re-keying. The email route would be a
step backwards.

**Your earlier answer: keep the API Bill.** *(Recommended — no work required.)*

Worth noting: if the appeal of the email route is having the signed form itself
filed in QBO as the supporting document, we can have both — API Bill for the
coding, plus the form PDF emailed in as backup. That needs a PDF generator added
(the repo has none) and attachment support in the mailer. Say so if you want it.

#### Decision B — does a clean submission bill automatically?

"Pay the installer as soon as all this is put in" reads as no human step. The
build keeps an admin approval gate.

- **Auto-bill clean submissions only** — if every line is confirmed at agreed
  pricing with photos attached, bill on submit with no human touch; route to
  `/admin/takeoffs` only when a line was unchecked or a price overridden. This is
  the closest honest reading of your spec while keeping eyes on exceptions.
- **Keep the manual gate** — every submission waits for approval. Safest, slowest.
  *(Your earlier answer.)*
- **Auto-bill everything** — including overrides. Not recommended: a bad price
  reaches QBO before anyone sees it.

**Please confirm A and B before I start.** They change what gets built.

---

### Gap 4 — The admin read endpoints are unauthenticated

`GET /api/sub-takeoffs` returns every takeoff with no authentication check, and
that includes the `token` column — which *is* the key to the public form. Anyone
who finds the URL can list live tokens and submit or re-price on a sub's behalf.
The same pattern affects `/api/subcontractors` (vendor IDs, emails, phones) and
`/api/labor-rates` (the entire agreed cost sheet). Writes are properly protected
on all three; only reads were missed.

This is live today and it gets more exposed as we auto-generate more tokens. It's
a small fix — the auth check already exists in each file and just isn't called on
the GET path.

**Recommend fixing this first, before anything else ships.**

---

### Gap 5 — Nobody outside this thread knows how it works

`/admin/docs-workflows` walks through quote → job → invoice → payment in plain
English. Subcontractor billing isn't in it. Worth a section so the office can run
this without asking.

---

### Proposed order of work

Each step is independently shippable and useful on its own.

| # | Step | Why here |
|---|---|---|
| 1 | Lock down the unauthenticated GETs (Gap 4) | Live exposure; do it before adding more tokens |
| 2 | Hold unmatched takeoffs; alias support on the rate card (2a + 2b) | Must land *with* or *before* automation, or auto-send emails $0 lines |
| 3 | Auto-generate + send on `JOB_CLOSED` (Gap 1) | The actual automation; safe once 2 is in |
| 4 | Whatever Decisions A and B change | Scope unknown until confirmed |
| 5 | Document it in `/admin/docs-workflows` (Gap 5) | Once behavior is settled |

Steps 1–3 are the release that delivers your spec. 4 depends on your answers, and
5 follows.

### Before it can run in production

- `admin/schema-vendor-payments.sql` and `admin/schema-labor.sql` must have been
  run in Supabase — I can't verify this from the repo
- The rate card must be loaded, or generation fails with "labor_rates is empty"
- Each sub needs a QBO vendor mapped and Jobber crew names attached, or the form
  can't self-assign or bill
- `QBO_AP_ACCOUNT` / `QBO_CONTRACTORS_COGS` should be set explicitly in Vercel
  rather than relying on the hardcoded `184` / `9` defaults
- The new workflow ships **enabled** (the publish check fails open). Unpublish it
  from `/admin/workflows` if you want to watch a dry run first.

### Risks

| Risk | Mitigation |
|---|---|
| A sub is emailed a form with unpriced lines | Step 2a holds it for the office instead |
| A re-closed job produces a second form and a second bill | Idempotent on job ID |
| A takeoff failure breaks the customer invoice | Isolated — a failed takeoff is logged and reported, never thrown; verified |
| The wrong sub is auto-detected from the crew | Admin can reassign before approving; the manual gate (Decision B) is the backstop |
| Duplicate bills in QBO | Approval refuses any takeoff already billed |

---

## Phase 2 — Sales rep commission

Not yet specified. There's existing rep infrastructure to build on
(`/admin/reps`, `api/salesrep-referral.js`, and Jobber records a salesperson on
each job), but the payment side is undefined.

To plan this I need to know:

1. **How is commission calculated?** Flat percentage, tiered, per-product, margin-based?
2. **What is it a percentage *of*?** Job total, collected revenue, gross margin?
3. **When is it earned?** Job completion, customer payment in full, or a delay after?
4. **How are reps paid?** QBO vendor bill like the subs, payroll, or something else?
5. **Do reps confirm anything**, like the subs do with their takeoff — or is it calculated and paid with no rep input?
6. **What about adjustments** — clawbacks on refunds or cancellations, splits between two reps?

Answer these and I'll extend this plan with a Phase 2 section in the same shape.

---

## What I need from you

1. **Approve or adjust the order of work** above
2. **Confirm Decision A** (QBO API Bill, or email to QBO)
3. **Confirm Decision B** (manual approval gate, or auto-bill clean submissions)
4. **Say what to do with the uncommitted Gap 1 code** — keep as Step 3 done, or revert
5. **Answer the Phase 2 questions** when you're ready to scope sales reps
