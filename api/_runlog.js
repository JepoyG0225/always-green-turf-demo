// Execution logging (n8n-style) — records each step's input + output for a run,
// then persists the whole run to Supabase `workflow_runs` for the viewer.
const SUPA = process.env.SUPABASE_URL || "https://otgpzpepmurbydcghygb.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

// Keep logged values sane: replace binaries, cap long strings.
function clip(v, max = 4000) {
  if (v == null) return v;
  if (Buffer.isBuffer(v)) return `[binary ${v.length} bytes]`;
  if (typeof v === "string") return v.length > max ? v.slice(0, max) + `…[+${v.length - max} chars]` : v;
  try {
    return JSON.parse(JSON.stringify(v, (k, val) => {
      if (Buffer.isBuffer(val)) return `[binary ${val.length} bytes]`;
      if (typeof val === "string" && val.length > max) return val.slice(0, max) + `…[+${val.length - max} chars]`;
      return val;
    }));
  } catch { return String(v).slice(0, max); }
}

module.exports = function newRun(workflow, trigger) {
  const steps = [];
  const startedAt = new Date().toISOString();
  return {
    steps,
    // Wrap an async unit of work; records input, output|error, duration.
    async step(name, input, fn) {
      const t0 = Date.now();
      const entry = { name, status: "running", input: clip(input) };
      steps.push(entry);
      try {
        const output = await fn();
        entry.status = "success"; entry.output = clip(output); entry.ms = Date.now() - t0;
        return output;
      } catch (e) {
        entry.status = "error"; entry.error = String((e && e.message) || e); entry.ms = Date.now() - t0;
        throw e;
      }
    },
    // Record a note/branch without running anything.
    info(name, data) { steps.push({ name, status: "info", output: clip(data) }); },
    async finish(status, summary) {
      if (!KEY) return;
      await fetch(`${SUPA}/rest/v1/workflow_runs`, {
        method: "POST",
        headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ workflow, status, summary, trigger_payload: clip(trigger), steps, started_at: startedAt, finished_at: new Date().toISOString() }),
      }).catch((e) => console.error("[runlog] write failed:", String(e.message || e)));
    },
  };
};
