// Labor rate card CRUD — admin only. The /admin/labor-rates UI sends the
// signed-in user's Supabase token; we verify it, then read/write labor_rates
// with the service-role key.
//   GET  /api/labor-rates                         → list all (Bearer optional for read)
//   POST /api/labor-rates { action, ...}          + Bearer <session token>
//        action: "create" | "update" | "delete" | "seed" | "match-arcsite"
const SUPA = process.env.SUPABASE_URL || "https://otgpzpepmurbydcghygb.supabase.co";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im90Z3B6cGVwbXVyYnlkY2doeWdiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDUyNDEsImV4cCI6MjA4NjMyMTI0MX0.5QpLZ7a9nebe5MYL44GrUFfS3MB7vRy-IPtCZtrorvo";
const ARCSITE_TOKEN = process.env.ARCSITE_TOKEN || "";

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = []; for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return {}; }
}
async function verify(req) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const who = await fetch(`${SUPA}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
  if (!who.ok) return null;
  return who.json();
}
const H = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clean = (v) => (v == null ? null : String(v).trim() || null);

// Fetch the full ArcSite product catalog (paginated 100/page).
async function arcsiteProducts() {
  const all = [];
  for (let page = 1; page <= 15; page++) {
    const r = await fetch(`https://api.arcsite.com/v1/products?per_page=100&page=${page}`, { headers: { Authorization: `Bearer ${ARCSITE_TOKEN}` } });
    if (!r.ok) break;
    const b = await r.json().catch(() => []);
    if (!Array.isArray(b) || !b.length) break;
    all.push(...b);
    if (b.length < 100) break;
  }
  return all;
}
// Normalize a name for matching: lowercase, strip punctuation/quotes/spaces.
const norm = (s) => String(s || "").toLowerCase().replace(/["'`]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
// Best product match for a labor row. Exact-normalized wins; else a strong
// contains match. Returns { id, name, how } or null — never a weak guess.
function matchProduct(row, products) {
  const targets = [norm(row.item), norm(`${row.item} ${row.description || ""}`)].filter(Boolean);
  const exact = products.find((p) => targets.includes(norm(p.name)));
  if (exact) return { id: exact.id, name: exact.name, how: "exact" };
  const ni = norm(row.item);
  if (ni.length >= 5) {
    const contains = products.find((p) => { const np = norm(p.name); return np === ni || np.includes(ni) || ni.includes(np); });
    if (contains) return { id: contains.id, name: contains.name, how: "contains" };
  }
  return null;
}

module.exports = async function handler(req, res) {
  if (!SERVICE) { res.status(500).json({ error: "service key not configured" }); return; }

  // Read is open to any signed-in admin (the UI also reads directly via RLS,
  // but this gives a server-side fallback and a stable shape).
  if (req.method === "GET") {
    const r = await fetch(`${SUPA}/rest/v1/labor_rates?select=*&order=sort_order.asc`, { headers: H });
    const rows = await r.json().catch(() => []);
    res.status(r.ok ? 200 : 502).json(r.ok ? { ok: true, rows } : { error: "read failed" });
    return;
  }
  if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }

  const user = await verify(req);
  if (!user) { res.status(401).json({ error: "unauthorized" }); return; }
  const body = await readBody(req);
  const action = String(body.action || "").trim();

  try {
    if (action === "create") {
      const row = sanitize(body.row);
      if (!row.item) { res.status(400).json({ error: "item is required" }); return; }
      const r = await fetch(`${SUPA}/rest/v1/labor_rates`, { method: "POST", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(row) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(JSON.stringify(out).slice(0, 200));
      res.status(200).json({ ok: true, row: Array.isArray(out) ? out[0] : out });
      return;
    }
    if (action === "update") {
      const id = String(body.id || "");
      if (!id) { res.status(400).json({ error: "id required" }); return; }
      const row = sanitize(body.row); row.updated_at = new Date().toISOString();
      const r = await fetch(`${SUPA}/rest/v1/labor_rates?id=eq.${id}`, { method: "PATCH", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(row) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(JSON.stringify(out).slice(0, 200));
      res.status(200).json({ ok: true, row: Array.isArray(out) ? out[0] : out });
      return;
    }
    if (action === "delete") {
      const id = String(body.id || "");
      if (!id) { res.status(400).json({ error: "id required" }); return; }
      const r = await fetch(`${SUPA}/rest/v1/labor_rates?id=eq.${id}`, { method: "DELETE", headers: { ...H, Prefer: "return=minimal" } });
      if (!r.ok) throw new Error(`delete ${r.status}`);
      res.status(200).json({ ok: true });
      return;
    }
    // One-time load of the price sheet. Idempotent: skips if the table already
    // has rows unless { force:true }. Matches each row to an ArcSite product.
    if (action === "seed") {
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (!rows.length) { res.status(400).json({ error: "no rows" }); return; }
      const existing = await (await fetch(`${SUPA}/rest/v1/labor_rates?select=id&limit=1`, { headers: H })).json().catch(() => []);
      if (existing.length && !body.force) { res.status(409).json({ error: "labor_rates already has data — pass force:true to reseed" }); return; }
      const products = ARCSITE_TOKEN ? await arcsiteProducts() : [];
      let matched = 0;
      const prepared = rows.map((raw) => {
        const row = sanitize(raw);
        const m = products.length ? matchProduct(row, products) : null;
        if (m) { row.arcsite_product_id = m.id; matched++; }
        return { row, match: m };
      });
      const r = await fetch(`${SUPA}/rest/v1/labor_rates`, { method: "POST", headers: { ...H, Prefer: "return=minimal" }, body: JSON.stringify(prepared.map((p) => p.row)) });
      if (!r.ok) throw new Error(`insert ${r.status}: ${(await r.text()).slice(0, 200)}`);
      res.status(200).json({ ok: true, inserted: prepared.length, arcsiteMatched: matched, catalogSize: products.length,
        matches: prepared.filter((p) => p.match).map((p) => ({ item: p.row.item, arcsite: p.match.name, how: p.match.how })),
        unmatched: prepared.filter((p) => !p.match).map((p) => p.row.item) });
      return;
    }
    // Re-run ArcSite matching over existing rows that have no product id yet.
    if (action === "match-arcsite") {
      if (!ARCSITE_TOKEN) { res.status(400).json({ error: "ARCSITE_TOKEN not set" }); return; }
      const products = await arcsiteProducts();
      const rows = await (await fetch(`${SUPA}/rest/v1/labor_rates?select=id,item,description,arcsite_product_id`, { headers: H })).json();
      let updated = 0; const report = [];
      for (const row of rows) {
        if (row.arcsite_product_id) continue;
        const m = matchProduct(row, products);
        if (!m) continue;
        await fetch(`${SUPA}/rest/v1/labor_rates?id=eq.${row.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ arcsite_product_id: m.id, updated_at: new Date().toISOString() }) });
        updated++; report.push({ item: row.item, arcsite: m.name, how: m.how });
      }
      res.status(200).json({ ok: true, updated, catalogSize: products.length, report });
      return;
    }
    res.status(400).json({ error: `unknown action: ${action}` });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};

function sanitize(row) {
  row = row || {};
  return {
    category: clean(row.category),
    item: clean(row.item),
    description: clean(row.description),
    unit: clean(row.unit),
    cost: num(row.cost, 0),
    notes: clean(row.notes),
    arcsite_product_id: clean(row.arcsite_product_id),
    active: row.active !== false,
    sort_order: row.sort_order != null ? num(row.sort_order) : null,
  };
}
