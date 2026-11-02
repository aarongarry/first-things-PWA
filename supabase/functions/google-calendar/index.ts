// Supabase Edge Function: Google Calendar OAuth for First Things.
// Deploy with:  npx supabase functions deploy google-calendar --no-verify-jwt
// (Google's redirect carries no Supabase token, so JWT checks must be off.)
// Secrets come from `npx supabase secrets set --env-file .env`; SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
import { createClient } from "npm:@supabase/supabase-js@2.49.4";
import { createHandler } from "./handler.js";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
// deno-lint-ignore no-explicit-any
const must = <T>(result: { data: T; error: any }) => {
  if (result.error) throw result.error;
  return result.data;
};
const connections = () => supabase.from("first_things_calendar_connections");
const states = () => supabase.from("first_things_calendar_oauth_states");

const db = {
  async accountId(phone: string) {
    const row = must(await supabase.from("first_things_demo_accounts")
      .select("identity_id").eq("phone", phone).eq("retired", false).maybeSingle());
    return row?.identity_id ?? null;
  },
  async saveState(row: Record<string, unknown>) {
    must(await states().delete().lt("expires_at", new Date().toISOString()));
    must(await states().insert(row));
  },
  async takeState(state: string) {
    // Delete-and-return makes every sign-in attempt single use.
    return must(await states().delete().eq("state", state).select().maybeSingle());
  },
  async getConnection(identityId: string) {
    return must(await connections().select("*").eq("identity_id", identityId).maybeSingle());
  },
  async saveConnection(row: Record<string, unknown>) {
    must(await connections().upsert(row));
  },
  async deleteConnection(identityId: string) {
    must(await connections().delete().eq("identity_id", identityId));
  },
};

let handler: (request: Request) => Promise<Response>;
try {
  handler = createHandler({ env: Deno.env.toObject(), db, fetch });
} catch (error) {
  // Missing secrets: answer readably so the app and logs say what to fix.
  console.error(error);
  handler = async () => new Response(
    JSON.stringify({ error: "Calendar connection isn’t finished setting up. You can continue without it." }),
    { status: 503, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
  );
}
Deno.serve(handler);
