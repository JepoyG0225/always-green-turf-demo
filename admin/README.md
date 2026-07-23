# DispatchAI (inside the Always Green Turf site)

Lead-to-rep dispatch, built into this repo the same way the time-off app is:
static admin pages that talk to Supabase from the browser, plus one serverless
function for the engine (which needs secret keys).

```
/dispatch/          ← admin UI (static, browser Supabase — like /admin)
  login.html          sign in
  index.html          dispatch logs
  reps.html           sales-rep CRUD
  config.js           ← FILL IN SUPABASE_URL + anon key
  dispatch.css        shared styles
  schema.sql          run once in Supabase
/api/dispatch.js    ← the engine (serverless, secrets via Vercel env vars)
```

## Setup

1. **Supabase** — run `dispatch/schema.sql` in the SQL editor, then put that
   project's URL + **anon** key into `dispatch/config.js`. Create an admin user
   in Supabase → Authentication → Users (keep public sign-ups off).

2. **Vercel env vars** (Project → Settings → Environment Variables) for the
   `/api/dispatch` function:

   ```
   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
   GOOGLE_MAPS_API_KEY
   GHL_API_TOKEN, GHL_LOCATION_ID, GHL_CALENDAR_ID, GHL_ENFORCE_ASSIGNMENT=true
   SENDGRID_API_KEY, FROM_EMAIL, FROM_NAME, BCC_EMAIL
   SLACK_BOT_TOKEN, SLACK_CHANNEL_ID
   ANTHROPIC_API_KEY, ANTHROPIC_MODEL=claude-opus-4-8
   DISPATCH_WEBHOOK_SECRET
   MAX_DRIVE_MINUTES=45, APPOINTMENT_DURATION_MINUTES=60
   ```

3. **Deploy** (`vercel --prod`). The static pages serve at `/dispatch/`, the
   engine at `/api/dispatch`.

4. **Point GHL** "Direct Booking-Dispatch" webhook at
   `https://<your-site>/api/dispatch` with header `x-webhook-secret`.

## Notes

- The `/api/dispatch.js` function has **zero npm dependencies** (pure Node +
  global fetch), so it adds no build step to the static site.
- Round-robin calendars: the engine sends `assignedUserId` + forces it via a
  follow-up `PUT` if GHL reassigns. Each log row records our pick vs GHL's so
  you can see if enforcement holds.
- ⚠️ Rotate the Google/GHL/SendGrid keys from the old n8n export before use.
