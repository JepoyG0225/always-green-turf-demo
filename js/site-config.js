// Always Green Turf — shared frontend config.
// Used by the public time-off form and the internal admin pages.
//
// SETUP CHECKLIST
//   1. SUPABASE_URL          — copy from Supabase dashboard → Project Settings → API
//   2. SUPABASE_ANON_KEY     — same place. Safe to expose; RLS policies guard the data.
//   3. SLACK_WEBHOOK         — https://api.slack.com/messaging/webhooks  (optional; leave "" to disable)
//
// NEVER paste the service_role key here. That key bypasses RLS and must stay server-side only.

export const SUPABASE_URL = "https://otgpzpepmurbydcghygb.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im90Z3B6cGVwbXVyYnlkY2doeWdiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDUyNDEsImV4cCI6MjA4NjMyMTI0MX0.5QpLZ7a9nebe5MYL44GrUFfS3MB7vRy-IPtCZtrorvo";
export const SLACK_WEBHOOK = "https://hooks.slack.com/triggers/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";
