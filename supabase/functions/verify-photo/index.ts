// Supabase Edge Function: checks a task photo with Claude for First Things.
// Deploy with:  npx supabase functions deploy verify-photo --no-verify-jwt
// (The app calls it like google-calendar, without a Supabase user token.)
// Secret: ANTHROPIC_API_KEY, set with `npx supabase secrets set`. APP_ORIGINS is
// shared with google-calendar. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are
// provided by Supabase automatically.
import Anthropic from "npm:@anthropic-ai/sdk@1.1.0";
import { createClient } from "npm:@supabase/supabase-js@2.49.4";
import { createHandler } from "./handler.js";
import { createJudge } from "./judge.js";

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

const db = {
  async accountId(phone: string) {
    const row = must(await supabase.from("first_things_demo_accounts")
      .select("identity_id").eq("phone", phone).eq("retired", false).maybeSingle());
    return row?.identity_id ?? null;
  },
  async takeCheck(identityId: string, perAccount: number, perApp: number) {
    return must(await supabase.rpc("first_things_take_photo_check",
      { who: identityId, per_account: perAccount, per_app: perApp }));
  },
};

let handler: (request: Request) => Promise<Response>;
try {
  const env = Deno.env.toObject();
  // One quick retry; the app falls back to photo-as-proof if this still fails.
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 20_000 });
  handler = createHandler({ env, db, judge: createJudge(anthropic) });
} catch (error) {
  // Missing secret: answer so the app still completes the task.
  console.error(error);
  handler = async () => new Response(
    JSON.stringify({ error: "Photo checking isn’t set up yet, so your photo counts as proof.", fallback: true }),
    { status: 503, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
  );
}
Deno.serve(handler);
