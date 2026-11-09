// =============================================================
// YOUR SUPABASE CONNECTION — fill these in when you are ready.
// 1. Project URL: Supabase dashboard → Connect.
// 2. Publishable key (or legacy anon/public key).
//    Never paste a secret or service_role key into browser code.
// 3. Run supabase/setup.sql and enable Anonymous Sign-Ins (see README).
// 4. Set USE_SUPABASE to true and refresh.
// =============================================================
export const SUPABASE_URL = "https://fvvekwiatzivjyvppwmp.supabase.co";
export const SUPABASE_KEY = "sb_publishable_mm0x3V2eBM_RjiiFZkVAXQ_h5iRVIkM";
// Public key for task reminders (push notifications). Make one with: npx web-push generate-vapid-keys
// Only the PUBLIC key goes here. Leave it empty to hide the reminders feature.
export const VAPID_PUBLIC_KEY = "BIzJZ8Lhdfo9mgQfcwnkFM8IVTlbTpDfwVH8XZq_NmM-i9yCIdS5LkqrVyyatChQhJ7Np3N2ya_aHxFoK_N2KSw";

export const USE_SUPABASE = true;

// With the switch off, tasks and goals stay in memory only.
let clientPromise;
export async function getSupabaseClient() {
  if (!USE_SUPABASE) return null;
  if (!SUPABASE_URL || SUPABASE_URL === "YOUR_PROJECT_URL" ||
      !SUPABASE_KEY || SUPABASE_KEY === "YOUR_PUBLISHABLE_OR_ANON_KEY") {
    throw new Error("Fill in SUPABASE_URL and SUPABASE_KEY in supabase-config.js first.");
  }
  if (!clientPromise) {
    // Load the SDK only when requested, so the disconnected demo works offline.
    clientPromise = import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm")
      .then(({ createClient }) => createClient(SUPABASE_URL, SUPABASE_KEY))
      .catch((error) => { clientPromise = undefined; throw error; });
  }
  return clientPromise;
}

// database.js connects the UI to the functions in supabase/setup.sql.
