// DispatchAI engine — Vercel serverless function (zero dependencies, global fetch).
// Deterministic lead-to-rep dispatch: memory → reps → geocode → distance →
// availability → book → email/Slack/memory. Secrets come from Vercel env vars.
//
// GHL webhook target:  https://<your-site>/api/dispatch   (header x-webhook-secret)

// ─────────────────────────── config (env) ───────────────────────────
const CFG = {
  supabaseUrl: process.env.SUPABASE_URL || "https://otgpzpepmurbydcghygb.supabase.co",
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  googleMapsKey: process.env.GOOGLE_MAPS_API_KEY || "",
  ghlToken: process.env.GHL_API_TOKEN || "",
  ghlLocationId: process.env.GHL_LOCATION_ID || "",
  ghlCalendarId: process.env.GHL_CALENDAR_ID || "",
  ghlEnforce: (process.env.GHL_ENFORCE_ASSIGNMENT || "true") === "true",
  sendgridKey: process.env.SENDGRID_API_KEY || "",
  fromEmail: process.env.FROM_EMAIL || "marketing@alwaysgreenturfaz.com",
  fromName: process.env.FROM_NAME || "Always Green Turf AZ",
  bccEmail: process.env.BCC_EMAIL || "",
  slackToken: process.env.SLACK_BOT_TOKEN || "",
  slackChannel: process.env.SLACK_CHANNEL_ID || "C0BAZDCT5K4",
  openaiKey: process.env.OPENAI_API_KEY || "",
  openaiModel: process.env.OPENAI_MODEL || "gpt-4o",
  webhookSecret: process.env.DISPATCH_WEBHOOK_SECRET || "",
  maxDrive: Number(process.env.MAX_DRIVE_MINUTES || "45"),
  duration: Number(process.env.APPOINTMENT_DURATION_MINUTES || "60"),
};

// ─────────────────────────── Phoenix time (UTC-7, no DST) ───────────────────────────
const PHX = 7 * 3600 * 1000;
const DOW = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

function parse12h(s) {
  const m = String(s).trim().toLowerCase().match(/(\d{1,2}):(\d{2})\s*([ap])m/);
  if (!m) return null;
  let hour = Number(m[1]) % 12;
  if (m[3] === "p") hour += 12;
  return { hour, min: Number(m[2]) };
}
function parseWindow(tw) {
  const [a, b] = String(tw || "").split("-");
  const start = a && parse12h(a), end = b && parse12h(b);
  return start && end ? { start, end } : null;
}
function parseDays(s) {
  return String(s || "").split(",").map((x) => DOW[x.trim().toLowerCase()]).filter((d) => d !== undefined);
}
function phxParts(utc) {
  const p = new Date(utc.getTime() - PHX);
  return { y: p.getUTCFullYear(), mo: p.getUTCMonth(), d: p.getUTCDate(), dow: p.getUTCDay() };
}
function phxWallToUtc(y, mo, d, hour, min) {
  return new Date(Date.UTC(y, mo, d, hour, min) + PHX);
}
function isoPhx(utc) {
  const p = new Date(utc.getTime() - PHX), z = (n) => String(n).padStart(2, "0");
  return `${p.getUTCFullYear()}-${z(p.getUTCMonth() + 1)}-${z(p.getUTCDate())}T${z(p.getUTCHours())}:${z(p.getUTCMinutes())}:${z(p.getUTCSeconds())}-07:00`;
}
const HUMAN = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Phoenix", weekday: "long", year: "numeric", month: "long",
  day: "numeric", hour: "numeric", minute: "2-digit",
});
function humanPhx(utc) { return HUMAN.format(utc); }

function candidates(now, dows, tw) {
  const p = phxParts(now), out = [];
  for (const dow of dows) {
    const until = (dow - p.dow + 7) % 7;
    for (const wk of [0, 1, 2]) {
      const add = until + wk * 7;
      out.push({
        startUtc: phxWallToUtc(p.y, p.mo, p.d + add, tw.start.hour, tw.start.min),
        endUtc: phxWallToUtc(p.y, p.mo, p.d + add, tw.end.hour, tw.end.min),
      });
    }
  }
  return out.filter((c) => c.startUtc.getTime() > now.getTime()).sort((a, b) => a.startUtc - b.startUtc);
}

// ─────────────────────────── Supabase REST ───────────────────────────
function sbHeaders(extra) {
  return { apikey: CFG.supabaseServiceKey, Authorization: `Bearer ${CFG.supabaseServiceKey}`, "Content-Type": "application/json", ...(extra || {}) };
}
async function sbSelect(table, query) {
  const res = await fetch(`${CFG.supabaseUrl}/rest/v1/${table}?${query}`, { headers: sbHeaders() });
  if (!res.ok) throw new Error(`supabase ${table} ${res.status}: ${await res.text()}`);
  return res.json();
}
async function sbInsert(table, row) {
  const res = await fetch(`${CFG.supabaseUrl}/rest/v1/${table}`, {
    method: "POST", headers: sbHeaders({ Prefer: "return=minimal" }), body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`supabase insert ${table} ${res.status}: ${await res.text()}`);
}
async function sbUpsert(table, row, onConflict) {
  const res = await fetch(`${CFG.supabaseUrl}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: "POST", headers: sbHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }), body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`supabase upsert ${table} ${res.status}: ${await res.text()}`);
}
async function sbPatch(table, query, patch) {
  await fetch(`${CFG.supabaseUrl}/rest/v1/${table}?${query}`, {
    method: "PATCH", headers: sbHeaders({ Prefer: "return=minimal" }), body: JSON.stringify(patch),
  }).catch(() => {});
}

// ─────────────────────────── Google ───────────────────────────
async function geocode(address) {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", address);
  url.searchParams.set("key", CFG.googleMapsKey);
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== "OK" || !data.results?.length) throw new Error(`geocode failed: ${address} (${data.status})`);
  return data.results[0].geometry.location; // {lat, lng}
}
async function driveMinutes(origin, dests) {
  const wp = (p) => ({ waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } });
  const res = await fetch("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": CFG.googleMapsKey, "X-Goog-FieldMask": "originIndex,destinationIndex,duration,condition" },
    body: JSON.stringify({ origins: [wp(origin)], destinations: dests.map(wp), travelMode: "DRIVE" }),
  });
  if (!res.ok) throw new Error(`distance matrix ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  const mins = new Array(dests.length).fill(Infinity);
  for (const r of rows) {
    if (r.condition && r.condition !== "ROUTE_EXISTS") continue;
    if (r.duration) mins[r.destinationIndex] = Math.round(Number(String(r.duration).replace("s", "")) / 60);
  }
  return mins;
}

// ─────────────────────────── GHL ───────────────────────────
function ghlHeaders() {
  return { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${CFG.ghlToken}`, Version: "2021-04-15" };
}
async function isRepFree(rep, cand) {
  const url = new URL("https://services.leadconnectorhq.com/calendars/events");
  url.searchParams.set("locationId", CFG.ghlLocationId);
  url.searchParams.set("calendarId", CFG.ghlCalendarId);
  url.searchParams.set("startTime", String(cand.startUtc.getTime()));
  url.searchParams.set("endTime", String(cand.endUtc.getTime()));
  url.searchParams.set("userId", rep.assigned_id);
  const res = await fetch(url, { headers: ghlHeaders() });
  if (!res.ok) throw new Error(`availability ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.events || []).length === 0;
}
async function book(rep, cand, lead) {
  const startUtc = cand.startUtc, endUtc = new Date(startUtc.getTime() + CFG.duration * 60000);
  const body = {
    title: `Sales Appointment - ${lead.first_name} ${lead.last_name}`,
    meetingLocationType: "custom", appointmentStatus: "confirmed",
    assignedUserId: rep.assigned_id, calendarId: CFG.ghlCalendarId, locationId: CFG.ghlLocationId,
    contactId: lead.contact_id, startTime: isoPhx(startUtc), endTime: isoPhx(endUtc),
    ignoreFreeSlotValidation: true,
    description: `Preferred Days: ${lead.preferredDays}\n\nTimewindow: ${lead.timeWindow}`,
  };
  const res = await fetch("https://services.leadconnectorhq.com/calendars/events/appointments", {
    method: "POST", headers: ghlHeaders(), body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`book ${res.status}: ${await res.text()}`);
  const data = await res.json(), appt = data.appointment || data;
  let assigned = appt.assignedUserId || rep.assigned_id;
  // Round-robin guard: force our chosen rep if GHL reassigned.
  if (CFG.ghlEnforce && assigned !== rep.assigned_id) {
    await fetch(`https://services.leadconnectorhq.com/calendars/events/appointments/${appt.id}`, {
      method: "PUT", headers: ghlHeaders(), body: JSON.stringify({ assignedUserId: rep.assigned_id }),
    }).catch(() => {});
    assigned = rep.assigned_id;
  }
  return { id: appt.id, assigned, startUtc };
}

// ─────────────────────────── Claude (messy-input parsing) ───────────────────────────
async function parseScheduleAI(body) {
  if (!CFG.openaiKey) return null;
  const signals = {};
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === "string" && v.trim() && /day|time|appointment|schedul|prefer|window|message|availab/i.test(k)) signals[k] = v.trim();
  }
  if (!Object.keys(signals).length) return null;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${CFG.openaiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CFG.openaiModel, max_tokens: 300,
      messages: [
        { role: "system", content: "Extract appointment scheduling preferences from raw CRM lead fields for an Arizona turf company. Only extract what is stated; do not invent." },
        { role: "user", content: `Lead fields (JSON):\n${JSON.stringify(signals, null, 2)}` },
      ],
      response_format: { type: "json_schema", json_schema: { name: "schedule", strict: true, schema: {
        type: "object",
        properties: {
          preferredDays: { type: "string", description: "Comma-separated full weekday names e.g. 'Friday,Saturday'. '' if none." },
          timeWindow: { type: "string", description: "'h:mmam-h:mmpm' e.g. '3:00pm-6:00pm'. morning->8:00am-12:00pm, afternoon->12:00pm-5:00pm, evening->5:00pm-8:00pm. '' if none." },
          found: { type: "boolean" },
        },
        required: ["preferredDays", "timeWindow", "found"], additionalProperties: false,
      } } },
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
    ? { text: data.choices[0].message.content } : null;
  if (!text) return null;
  try { const p = JSON.parse(text.text); return p.found ? p : null; } catch { return null; }
}

// ─────────────────────────── other integrations ───────────────────────────
// Confirmation email via Resend (RESEND_API_KEY + RESEND_FROM are set on the
// project; the domain is verified on that account). Throws on failure so the
// step is recorded as an error in the audit log rather than silently passing.
async function sendEmail(lead, whenText) {
  const key = process.env.RESEND_API_KEY || "";
  const from = process.env.RESEND_FROM || "Always Green Turf <admin@alwaysgreenturfaz.com>";
  if (!key) throw new Error("RESEND_API_KEY not set");
  if (!lead.email) throw new Error("lead has no email");
  const body = {
    from, to: [lead.email],
    subject: `Your Appointment is Confirmed - ${lead.first_name} ${lead.last_name}`,
    html: emailHtml(lead.first_name, whenText),
  };
  if (CFG.bccEmail) body.bcc = [CFG.bccEmail];
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
function emailHtml(name, when) {
  return `<!DOCTYPE html><html><body style="margin:0;background:#eef2ee;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:16px;overflow:hidden;">
<tr><td style="background-image:linear-gradient(135deg,#1b7a3e,#14532d);padding:36px 40px;color:#fff;">
<div style="font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#a7e3bd;font-weight:600;">Always Green Turf AZ</div>
<div style="padding-top:14px;font-size:28px;font-weight:700;">Your appointment is confirmed &#10003;</div></td></tr>
<tr><td style="height:5px;background:#7ed957;font-size:0;">&nbsp;</td></tr>
<tr><td style="padding:36px 40px;"><p style="margin:0;font-size:18px;color:#1f2d24;font-weight:600;">Hi ${name},</p>
<p style="margin:14px 0 0;font-size:16px;color:#445349;">Thanks for booking with us. Here are your appointment details:</p>
<table width="100%" style="margin-top:20px;background:#f1f8f3;border:1px solid #d6ecdd;border-radius:14px;"><tr><td style="padding:22px;">
<p style="margin:0;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:#1b7a3e;font-weight:700;">Appointment</p>
<p style="margin:8px 0 0;font-size:19px;color:#1f2d24;font-weight:700;">${when}</p>
<p style="margin:4px 0 0;font-size:14px;color:#6b7d70;">Time zone: America/Phoenix (MST)</p></td></tr></table></td></tr>
<tr><td style="background:#f1f8f3;padding:24px 40px;"><p style="margin:0;font-size:15px;color:#1f2d24;font-weight:700;">Always Green Turf AZ</p>
<p style="margin:6px 0 0;font-size:13px;color:#6b7d70;">Premium artificial turf installation &middot; Arizona</p></td></tr>
</table></td></tr></table></body></html>`;
}
async function notifySlack(lead, rep, whenText) {
  if (!CFG.slackToken || !CFG.slackChannel) return;
  const mapsLink = lead.address ? `<https://maps.google.com/?q=${encodeURIComponent(lead.address)}|${lead.address}>` : "—";
  const text =
    `🗓️ *New Appointment Booking*\n\n` +
    `*Customer:* ${lead.first_name} ${lead.last_name}\n` +
    (lead.phone ? `*Phone:* ${lead.phone}\n` : "") +
    `*Address:* ${mapsLink}\n` +
    `*When:* ${whenText} (America/Phoenix)\n` +
    `*Sales Rep:* ${rep.name} (${rep.driveMinutes} min away)\n` +
    `*Approx. Project Size:* ${lead.yardSize || "n/a"}`;
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST", headers: { Authorization: `Bearer ${CFG.slackToken}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: CFG.slackChannel, text }),
  });
}

// ─────────────────────────── normalize ───────────────────────────
function normalize(payload) {
  const b = (payload && payload.body) || payload || {};
  const raw = b.full_address || b.address_full || b.address || b.address1 || b.street_address ||
    [b.address_street, b.address_city, b.address_state, b.address_zip].filter(Boolean).join(", ") || "";
  const days = b.PreferredDays || b.preferredDays || (Array.isArray(b.available_days) ? b.available_days.join(",") : b.available_days) || "";
  const win = b.timewindow || b.timeWindow || (Array.isArray(b.best_time_windows) ? b.best_time_windows[0] : b.best_time_windows) || "";
  return {
    body: b,
    contact_id: b.contact_id || "", first_name: b.first_name || "", last_name: b.last_name || "",
    email: b.email || "", phone: b.phone || b.phone_formatted || "", address: raw,
    addressKey: String(raw).toLowerCase().trim().replace(/,/g, "").replace(/\s+/g, " "),
    // Online booking picks an exact slot; when present we book that time directly (no day/window search).
    selectedSlot: b.selected_slot || b.selectedSlot || "",
    preferredDays: days,
    timeWindow: win,
    yardSize: b["What’s your approximate yard size?"] || b.yard_size || b.area_size || b["project sqft"] || "",
  };
}

// ─────────────────────────── orchestrator ───────────────────────────
async function runDispatch(payload) {
  const steps = [], startedAt = Date.now();
  const step = async (name, fn) => {
    const t = Date.now();
    try { const r = await fn(); steps.push({ step: name, ok: true, ms: Date.now() - t }); return r; }
    catch (e) { steps.push({ step: name, ok: false, ms: Date.now() - t, error: String(e.message || e) }); throw e; }
  };
  const optional = async (name, fn) => { try { return await step(name, fn); } catch { return null; } };

  const lead = normalize(payload);
  const log = {
    contact_id: lead.contact_id, lead_name: `${lead.first_name} ${lead.last_name}`.trim(),
    lead_email: lead.email, lead_address: lead.address, address_key: lead.addressKey,
    preferred_days: lead.preferredDays, time_window: lead.timeWindow, raw_payload: payload,
  };
  let result = { status: "error", remarks: "Unknown error" };

  try {
    for (const k of ["supabaseUrl", "supabaseServiceKey", "googleMapsKey", "ghlToken", "ghlLocationId", "ghlCalendarId"])
      if (!CFG[k]) throw new Error(`Missing env var for ${k}`);

    if (!lead.addressKey) { result = { status: "missing_address", remarks: "Could not dispatch. Missing: valid lead address." }; return result; }

    // memory
    const mem = await step("memory_lookup", async () => {
      const rows = await sbSelect("dispatch_memory", `address_key=eq.${encodeURIComponent(lead.addressKey)}&order=last_dispatched_at.desc.nullslast&limit=1`);
      return rows[0] || null;
    });
    log.memory_hit = !!mem;
    if (mem && (mem.locked === true || mem.locked === "true")) {
      result = { status: "memory_locked", remarks: `Address is locked to ${mem.rep_name}. No new booking created.` };
      log.chosen_rep_id = mem.assigned_id; log.chosen_rep_name = mem.rep_name; return result;
    }
    const preferredRepId = mem ? mem.assigned_id : null;

    // reps
    const reps = (await step("get_reps", () => sbSelect("sales_rep_data", "select=*"))).filter((r) => r.active !== false);
    if (!reps.length) throw new Error("No active sales reps found");

    // geocode
    const leadLoc = await step("geocode_lead", () => geocode(lead.address));
    const repLocs = await step("geocode_reps", () => Promise.all(reps.map(async (r) => {
      if (typeof r.lat === "number" && typeof r.lng === "number") return { lat: r.lat, lng: r.lng };
      const loc = await geocode(r.address);
      await sbPatch("sales_rep_data", `assigned_id=eq.${encodeURIComponent(r.assigned_id)}`, { lat: loc.lat, lng: loc.lng });
      return loc;
    })));

    // distance
    const mins = await step("distance_matrix", () => driveMinutes(leadLoc, repLocs));
    reps.forEach((r, i) => { r.driveMinutes = mins[i]; });

    const qualified = reps.filter((r) => (r.driveMinutes ?? Infinity) <= CFG.maxDrive).sort((a, b) => {
      if (a.assigned_id === preferredRepId) return -1;
      if (b.assigned_id === preferredRepId) return 1;
      return (a.driveMinutes ?? Infinity) - (b.driveMinutes ?? Infinity);
    });
    if (!qualified.length) {
      const nearest = [...reps].sort((a, b) => (a.driveMinutes ?? Infinity) - (b.driveMinutes ?? Infinity))[0];
      result = { status: "no_rep_distance", remarks: `No appointment booked. All reps are more than ${CFG.maxDrive} minutes from the lead location. Nearest rep is ${nearest.name} at ${nearest.driveMinutes} min.` };
      return result;
    }

    // schedule: exact slot (online booking) OR deterministic day/window (+ Claude for messy input)
    let cands;
    if (lead.selectedSlot) {
      // Customer chose a specific open time on the site — book that exact slot with the nearest free rep.
      const startUtc = new Date(lead.selectedSlot);
      if (isNaN(startUtc.getTime())) throw new Error(`Invalid selected_slot: "${lead.selectedSlot}"`);
      if (startUtc.getTime() <= Date.now()) throw new Error(`selected_slot is in the past: "${lead.selectedSlot}"`);
      cands = [{ startUtc, endUtc: new Date(startUtc.getTime() + CFG.duration * 60000) }];
    } else {
      let dows = parseDays(lead.preferredDays), tw = parseWindow(lead.timeWindow);
      if ((!dows.length || !tw) && CFG.openaiKey) {
        const ai = await optional("ai_parse_schedule", () => parseScheduleAI(lead.body));
        if (ai) {
          if (!dows.length && ai.preferredDays) { lead.preferredDays = ai.preferredDays; dows = parseDays(ai.preferredDays); }
          if (!tw && ai.timeWindow) { lead.timeWindow = ai.timeWindow; tw = parseWindow(ai.timeWindow); }
          log.preferred_days = lead.preferredDays; log.time_window = lead.timeWindow;
        }
      }
      if (!dows.length || !tw) throw new Error(`Could not resolve preferred day/time (days="${lead.preferredDays}" window="${lead.timeWindow}")`);
      cands = candidates(new Date(), dows, tw);
    }
    if (!cands.length) throw new Error("No future candidate dates");
    let chosen = null, chosenCand = cands[0];
    const skipped = new Set(); // reps whose availability check errors — skip for remaining candidates too
    await step("find_availability", async () => {
      for (const c of cands) {
        for (const rep of qualified) {
          if (skipped.has(rep.assigned_id)) continue;
          try {
            if (await isRepFree(rep, c)) { chosen = rep; chosenCand = c; return; }
          } catch (e) {
            // One bad rep (e.g. deleted GHL user → 400) must not kill the whole dispatch.
            skipped.add(rep.assigned_id);
            console.warn(`[dispatch] availability skipped for ${rep.name} (${rep.assigned_id}): ${String(e.message || e)}`);
          }
        }
      }
    });
    if (!chosen) { result = { status: "no_rep_availability", remarks: `No appointment booked. All nearby reps are fully booked on ${lead.preferredDays}.` }; return result; }

    // book + follow-ups
    const booking = await step("book_appointment", () => book(chosen, chosenCand, lead));
    const whenText = humanPhx(booking.startUtc);
    await optional("send_confirmation_email", () => sendEmail(lead, whenText));
    await optional("memory_save", () => sbUpsert("dispatch_memory", {
      address_key: lead.addressKey, assigned_id: chosen.assigned_id, rep_name: chosen.name,
      calendar_id: CFG.ghlCalendarId, rep_address: chosen.address,
      dispatch_count: ((mem && mem.dispatch_count) || 0) + 1, last_dispatched_at: new Date().toISOString(),
      locked: false, Reason: `${chosen.name} was ${chosen.driveMinutes} minutes away and available at ${whenText}.`,
    }, "address_key"));
    await optional("notify_slack", () => notifySlack(lead, chosen, whenText));

    result = { status: "booked", remarks: `Appointment booked with ${chosen.name} on ${whenText} America/Phoenix.` };
    log.chosen_rep_id = chosen.assigned_id; log.chosen_rep_name = chosen.name; log.drive_minutes = chosen.driveMinutes;
    log.appointment_id = booking.id; log.appointment_start = booking.startUtc.toISOString(); log.ghl_assigned_id = booking.assigned;
    return result;
  } catch (e) {
    result = { status: "error", remarks: `Dispatch failed: ${String(e.message || e)}` }; log.error = String(e.message || e);
    return result;
  } finally {
    log.status = result.status; log.remarks = result.remarks; log.steps = steps; log.duration_ms = Date.now() - startedAt;

    // (1) Persistent DB audit — dispatch_logs (works once the table exists; the
    //     Supabase key can insert). Non-fatal.
    let dbLogged = false;
    if (CFG.supabaseUrl && CFG.supabaseServiceKey) {
      dbLogged = await sbInsert("dispatch_logs", log).then(() => true)
        .catch((e) => { console.error("[dispatch] db-log failed:", String(e.message || e)); return false; });
    }

    // (2) Always emit a structured audit line to the function logs, so every
    //     dispatch is auditable even if the DB write isn't available.
    console.log("[dispatch-audit] " + JSON.stringify({
      ts: new Date().toISOString(),
      status: log.status,
      lead_name: log.lead_name,
      lead_address: log.lead_address,
      contact_id: log.contact_id,
      chosen_rep_name: log.chosen_rep_name,
      chosen_rep_id: log.chosen_rep_id,
      ghl_assigned_id: log.ghl_assigned_id,
      drive_minutes: log.drive_minutes,
      appointment_id: log.appointment_id,
      appointment_start: log.appointment_start,
      remarks: log.remarks,
      error: log.error || null,
      duration_ms: log.duration_ms,
      steps: steps.map((s) => s.step + (s.ok ? "" : ":ERR")),
      db_logged: dbLogged,
    }));
  }
}

// ─────────────────────────── handler ───────────────────────────
async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return {}; }
}

module.exports = async function handler(req, res) {
  if (req.method === "GET") { res.status(200).json({ ok: true, service: "dispatchai", hint: "POST a lead payload here" }); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }

  if (CFG.webhookSecret) {
    const provided = req.headers["x-webhook-secret"] || (req.query && req.query.secret);
    if (provided !== CFG.webhookSecret) { res.status(401).json({ error: "unauthorized" }); return; }
  }

  const payload = await readBody(req);
  const result = await runDispatch(payload);
  res.status(result.status === "error" ? 500 : 200).json({ remarks: result.remarks, status: result.status });
}

// Allow other serverless functions (e.g. /api/book) to run the dispatch logic in-process.
module.exports.runDispatch = runDispatch;
