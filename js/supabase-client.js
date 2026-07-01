// Shared Supabase client. Initialize once, import everywhere.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./site-config.js";

if (!SUPABASE_URL || SUPABASE_ANON_KEY.startsWith("PASTE_")) {
  console.warn(
    "[supabase-client] SUPABASE_ANON_KEY not configured. " +
    "Open js/site-config.js and paste your anon key from the Supabase dashboard."
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storage: window.localStorage,
    storageKey: "agt-admin-auth",
  },
});
