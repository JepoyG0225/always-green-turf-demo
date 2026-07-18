// Warranty claim intake → Claude analysis → auto-response email.
//
// Claude (vision) reviews the customer's description + photos and classifies
// the claim. Two categories are explicitly NOT covered by the Limited Warranty
// and get an immediate templated response (from AGT's approved copy):
//   - reflection_damage  (heat reflection from Low-E windows/glass melting fibers)
//   - weed_growth        (weeds through/at turf edges — routine maintenance)
// Everything else (or anything uncertain) gets the Claim Acknowledgment email
// and goes to the warranty team for human review. The AI only auto-declines on
// HIGH confidence with clear photo evidence — when in doubt, a human reviews.
//
// Side effects: GHL contact upsert (tag: warranty-claim), Resend email to the
// customer, Slack notification with the AI verdict, dispatch_logs audit row.

const upsertGhlContact = require("./_ghl-contact");

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";
const RESEND_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM = process.env.RESEND_FROM || "Always Green Turf <admin@alwaysgreenturfaz.com>";
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_CHANNEL = process.env.SLACK_WARRANTY_CHANNEL || process.env.SLACK_CHANNEL_ID || "C0BAZDCT5K4";
const SUPA = process.env.SUPABASE_URL || "https://otgpzpepmurbydcghygb.supabase.co";
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const GHL_LOC = process.env.GHL_LOCATION_ID || "dpp7zOnwhkHGWhn5lGRd";

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = []; for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return {}; }
}

// ── Claude claim analysis ────────────────────────────────────────────
const SCHEMA = {
  type: "object",
  properties: {
    classification: {
      type: "string",
      enum: ["reflection_damage", "weed_growth", "needs_review"],
      description: "reflection_damage: melted/singed turf fibers in localized streaks or patches consistent with concentrated sunlight reflecting off a window/glass/metal surface. weed_growth: weeds/plants sprouting through the turf or along its edges. needs_review: ANYTHING else — seams lifting, drainage, infill, discoloration without melt patterns, product defects, unclear photos, or mixed/multiple issues.",
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    reasoning: { type: "string", description: "2-4 sentences: what the photos show and why this classification." },
  },
  required: ["classification", "confidence", "reasoning"],
  additionalProperties: false,
};

async function analyzeClaim(claim) {
  const content = [];
  for (const p of (claim.photos || []).slice(0, 8)) {
    if (p && p.url) content.push({ type: "image", source: { type: "url", url: p.url } });
  }
  content.push({
    type: "text",
    text:
      `Warranty claim for an artificial turf installation in Arizona.\n\n` +
      `Customer description: "${claim.message}"\n` +
      `Installation date: ${claim.installationDate || "unknown"}\n\n` +
      `Classify this claim per the schema. Rules:\n` +
      `- Only use reflection_damage or weed_growth when the PHOTOS clearly show it (the description alone is not enough).\n` +
      `- Reflection damage looks like melted, shriveled, or singed fibers in a defined band/patch, often near windows or walls.\n` +
      `- Weed growth is visible plants emerging through or beside the turf.\n` +
      `- If evidence is unclear, mixed, or shows any potentially covered issue (seams, wrinkles, drainage, infill loss, fading, workmanship), use needs_review.\n` +
      `- When in doubt, needs_review — a human will look at it.`,
  });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1500,
      thinking: { type: "adaptive" },
      system:
        "You are the warranty triage analyst for Always Green Turf AZ, an artificial turf installer. " +
        "You examine claim photos and descriptions and classify claims strictly per the provided rules. " +
        "Auto-classifiable categories require clear visual evidence; otherwise route to human review.",
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(data.error && data.error.message) || ""}`.slice(0, 200));
  if (data.stop_reason === "refusal") throw new Error("analysis refused");
  const text = (data.content || []).find((b) => b.type === "text");
  if (!text) throw new Error("no analysis text");
  return JSON.parse(text.text);
}

// ── Email templates (AGT-approved copy) ──────────────────────────────
function wrap(inner) {
  return `<!DOCTYPE html><html><body style="margin:0;background:#eef2ee;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:16px;overflow:hidden;">
<tr><td style="background-image:linear-gradient(135deg,#1b7a3e,#14532d);padding:32px 40px;color:#fff;">
<div style="font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#a7e3bd;font-weight:600;">Always Green Turf AZ</div>
<div style="padding-top:12px;font-size:26px;font-weight:700;">${inner.title}</div></td></tr>
<tr><td style="height:5px;background:#7ed957;font-size:0;">&nbsp;</td></tr>
<tr><td style="padding:32px 40px;font-size:15px;line-height:1.65;color:#374151;">${inner.body}</td></tr>
<tr><td style="background:#f1f8f3;padding:22px 40px;">
<p style="margin:0;font-size:14px;color:#1f2d24;font-weight:700;">The Always Green Turf Team</p>
<p style="margin:6px 0 0;font-size:12px;color:#6b7d70;">204 S Mesa Dr, Mesa, AZ 85210 &middot; (480) 455-7056 &middot; ROC 328641 &middot; alwaysgreenturfaz.com</p>
</td></tr></table></td></tr></table></body></html>`;
}
const h3 = (t) => `<p style="margin:22px 0 8px;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:#1b7a3e;font-weight:700;">${t}</p>`;
const li = (b, t) => `<p style="margin:8px 0;"><strong>${b}</strong> ${t}</p>`;

function acknowledgmentEmail(first) {
  return { subject: "We've received your warranty claim", html: wrap({ title: "We've received your warranty claim", body:
    `<p style="margin:0;">Hi ${first},</p>
<p>Thank you for reaching out and for trusting Always Green Turf with your yard. We're sorry for any inconvenience this issue has caused — we know how much you care about your outdoor space, and we want it looking its best.</p>
<p>Your claim and any photos you submitted have been received and are now being reviewed by our warranty team.</p>
${h3("What happens next")}
${li("1. Review.", "Our team will review your claim details and photos within 5 business days.")}
${li("2. Follow-up.", "We'll contact you to ask any questions and, if needed, schedule an on-site inspection at a time that works for you.")}
${li("3. Resolution.", "Once we've assessed the issue, we'll walk you through exactly what we found and the next steps.")}
<p>There's nothing else you need to do right now. If you'd like to add photos or details to your claim in the meantime, just reply to this email.</p>
<p>Thank you for your patience — you'll hear from us within 5 business days.</p>` }) };
}

function reflectionEmail(first) {
  return { subject: "About your warranty claim", html: wrap({ title: "About your warranty claim", body:
    `<p style="margin:0;">Hi ${first},</p>
<p>Thank you for submitting your warranty claim and for sharing photos of your lawn. We're truly sorry to see this happen — we know how frustrating it is to find damage on a yard you've invested in, and we appreciate you bringing it to us.</p>
<p>After reviewing your claim, the damage shown is consistent with <strong>heat reflection</strong> — concentrated sunlight bouncing off a reflective surface such as an energy-efficient (Low-E) window, mirror, metal, or glass. In the Arizona sun, these reflections can reach temperatures high enough to soften or melt turf fibers in the areas they hit.</p>
<p>Because this type of damage is caused by an outside heat source rather than the turf product or our installation, it falls outside the coverage of our Limited Warranty. We sincerely wish we could cover every situation, but reflection damage is unfortunately something no turf product on the market is able to withstand, and it isn't something we're able to control or prevent through the installation itself.</p>
${h3("The good news: it's preventable")}
<p>Once the reflection source is addressed, the damage won't repeat. A few simple, effective options:</p>
${li("Window screens.", "Standard exterior solar screens on the reflecting window diffuse the light before it reaches your lawn — the most common and affordable fix.")}
${li("Turf-safe window film.", "An anti-reflective exterior film applied to the glass.")}
${li("Shade.", "A shade sail, awning, or well-placed patio umbrella can block the reflection path during peak afternoon hours.")}
<p>Addressing the reflection source is the most important step — it protects the rest of your lawn and ensures the issue doesn't spread or repeat. If you have any questions about identifying the source or choosing the right solution, we're happy to point you in the right direction.</p>
<p>Thank you for your understanding, and for being part of the Always Green Turf family.</p>` }) };
}

function weedEmail(first) {
  return { subject: "About your warranty claim", html: wrap({ title: "About your warranty claim", body:
    `<p style="margin:0;">Hi ${first},</p>
<p>Thank you for submitting your warranty claim — we appreciate you letting us know what's going on with your lawn, and we're sorry for the frustration unwanted growth can cause.</p>
<p>Here's the honest truth about weeds: they're remarkably persistent. They can sprout anywhere — even through cracks in asphalt and concrete — and while we take preventive measures during every installation, no treatment can permanently stop airborne seeds from landing and taking root over time, especially along turf edges.</p>
<p>Because weed growth comes from nature rather than the turf product or our installation, ongoing weed maintenance falls outside our Limited Warranty and is part of routine lawn care — much like it would be with a natural lawn, just far less of it. We sincerely wish we could control this one for you, but it's simply beyond what any installer can prevent.</p>
${h3("The good news: it's easy to manage")}
${li("Spot-treat, don't spray broadly.", "Apply a weed treatment such as Roundup 365 directly onto the weed itself and let it sit so it reaches the roots. Avoid broadcast-spraying across the turf — keeping the product on the weed protects your fibers, as chemical damage to the turf isn't covered under warranty.")}
${li("Catch them small.", "Young weeds at the edges can be pulled by hand before they establish roots.")}
${li("Keep it clean.", "Rinse the turf periodically with the shower setting on your hose (avoid the jet setting, which can displace the infill) and clear leaves and debris — organic material sitting on turf is where seeds like to settle.")}
<p>With a little spot treatment as weeds appear, they're quick to knock down and your lawn will keep looking its best year-round.</p>
<p>Thank you for your understanding, and for being part of the Always Green Turf family.</p>` }) };
}

async function sendEmail(to, tpl) {
  if (!RESEND_KEY) throw new Error("RESEND_API_KEY not set");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: RESEND_FROM, to: [to], subject: tpl.subject, html: tpl.html }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// ── handler ──────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }
  const b = await readBody(req);
  const fullName = String(b.fullName || "").trim();
  const email = String(b.email || "").trim();
  const phone = String(b.phone || "").trim();
  const message = String(b.message || "").trim();
  const photos = Array.isArray(b.photos) ? b.photos : [];
  if (!fullName || !email || !message) { res.status(400).json({ error: "name, email and message are required" }); return; }
  const first = fullName.split(/\s+/)[0];
  const steps = [];
  const step = async (name, fn) => {
    const t = Date.now();
    try { const r = await fn(); steps.push({ step: name, ok: true, ms: Date.now() - t }); return r; }
    catch (e) { steps.push({ step: name, ok: false, ms: Date.now() - t, error: String(e.message || e) }); return null; }
  };

  // 1) GHL contact
  const contact = await step("ghl_contact", () => upsertGhlContact({
    firstName: first, lastName: fullName.split(/\s+/).slice(1).join(" "), email, phone,
    tags: ["warranty-claim", "website"], source: "Website — Warranty Claim Form",
  }));

  // 2) Claude analysis (photos + description)
  let verdict = null;
  if (ANTHROPIC_KEY) verdict = await step("ai_analysis", () => analyzeClaim({ message, installationDate: b.installationDate, photos }));

  // 3) Pick response: auto-decline only on high-confidence known exclusions
  let template = "acknowledgment", tpl = acknowledgmentEmail(first);
  if (verdict && verdict.confidence === "high") {
    if (verdict.classification === "reflection_damage") { template = "reflection_damage"; tpl = reflectionEmail(first); }
    else if (verdict.classification === "weed_growth") { template = "weed_growth"; tpl = weedEmail(first); }
  }

  // 4) Email the customer
  const emailed = await step("send_email", async () => { await sendEmail(email, tpl); return true; });

  // 5) Slack the team
  await step("notify_slack", async () => {
    if (!SLACK_TOKEN) throw new Error("no slack token");
    const v = verdict
      ? `*AI verdict:* ${verdict.classification} (${verdict.confidence})\n>${verdict.reasoning}`
      : "*AI verdict:* _analysis unavailable — routed to human review_";
    const text =
      `🛠️ *New Warranty Claim*\n\n` +
      `*Customer:* ${fullName}\n*Email:* ${email}\n*Phone:* ${phone}\n` +
      `*Installed:* ${b.installationDate || "—"}\n` +
      `*Message:* ${message.slice(0, 400)}\n` +
      `*Photos:* ${photos.map((p, i) => `<${p.url}|#${i + 1}>`).join(" ") || "—"}\n` +
      (contact ? `*GHL Contact:* <https://app.gohighlevel.com/v2/location/${GHL_LOC}/contacts/detail/${contact.id}|open>\n` : "") +
      `${v}\n` +
      `*Auto-response sent:* ${template}${emailed ? "" : " (⚠ email FAILED)"}`;
    const r = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST", headers: { Authorization: `Bearer ${SLACK_TOKEN}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: SLACK_CHANNEL, text }),
    });
    const d = await r.json(); if (!d.ok) throw new Error(`slack: ${d.error}`);
  });

  // 6) Audit row
  await step("log", async () => {
    if (!SUPA_KEY) throw new Error("no supabase key");
    const r = await fetch(`${SUPA}/rest/v1/dispatch_logs`, {
      method: "POST",
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        status: "warranty_claim",
        contact_id: contact && contact.id,
        lead_name: fullName, lead_email: email,
        remarks: `Warranty claim — ${verdict ? `AI: ${verdict.classification} (${verdict.confidence})` : "AI unavailable"} → sent "${template}" email.`,
        steps, raw_payload: { ...b, ai_verdict: verdict },
      }),
    });
    if (!r.ok) throw new Error(`supabase ${r.status}`);
  });

  console.log("[warranty-audit] " + JSON.stringify({
    ts: new Date().toISOString(), customer: fullName, email,
    verdict: verdict && { c: verdict.classification, conf: verdict.confidence },
    template, emailed: !!emailed, steps: steps.map((s) => s.step + (s.ok ? "" : ":ERR")),
  }));

  if (!emailed) { res.status(502).json({ error: "Your claim was received but the confirmation email failed — our team will still review it." }); return; }
  res.status(200).json({ ok: true, template });
};
