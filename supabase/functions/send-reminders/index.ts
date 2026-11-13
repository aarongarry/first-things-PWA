// Sends the daily "you still have first things left" push notifications.
// Run every minute by Supabase Cron (see README → Task reminders).
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";
import { createECDH } from "node:crypto";
import { Buffer } from "node:buffer";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
// Trim the secrets: a stray space or line break from pasting makes Apple reject every push.
const secret = (name: string) => (Deno.env.get(name) ?? "").trim();
webpush.setVapidDetails(
  secret("VAPID_SUBJECT"),
  secret("VAPID_PUBLIC_KEY"),
  secret("VAPID_PRIVATE_KEY"),
);

// Self-check of the secrets, without revealing them: does the private key belong to the
// public key, and is the subject a mailto:/https: address Apple will accept?
function configCheck() {
  const pub = (Deno.env.get("VAPID_PUBLIC_KEY") ?? "").trim();
  const priv = (Deno.env.get("VAPID_PRIVATE_KEY") ?? "").trim();
  const subject = (Deno.env.get("VAPID_SUBJECT") ?? "").trim();
  let keysMatch = false;
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(priv, "base64url"));
    keysMatch = ecdh.getPublicKey().toString("base64url") === pub;
  } catch { /* malformed key: keysMatch stays false */ }
  return {
    keysMatch,
    publicKeyStart: pub.slice(0, 6),
    privateKeyLength: priv.length,
    subjectOk: /^mailto:[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(subject) || /^https:\/\/\S+$/.test(subject),
    subjectStart: subject.slice(0, 7),
    // true = that secret was saved with extra spaces or line breaks (now trimmed automatically)
    extraSpaces: ["VAPID_SUBJECT", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"]
      .filter((name) => (Deno.env.get(name) ?? "") !== (Deno.env.get(name) ?? "").trim()),
    subjectLength: subject.length,
  };
}

Deno.serve(async (request) => {
  // Deployed with --no-verify-jwt, so this shared secret is the only way in.
  if (request.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) {
    return new Response("Forbidden", { status: 403 });
  }
  const { data, error } = await supabase.rpc("first_things_due_reminders");
  if (error) return new Response(error.message, { status: 500 });

  const sent: string[] = [];
  const dead: string[] = [];
  const failed: { status: number; reason: string }[] = [];
  await Promise.all((data ?? []).map(async (row: any) => {
    const left = row.remaining as number;
    // Personal and short: the user's name, then how many tasks are left today.
    const payload = JSON.stringify({
      title: String(row.name || "Friend"),
      body: `${left} task${left === 1 ? "" : "s"} left today`,
    });
    try {
      await webpush.sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        payload,
        { TTL: 60 * 60 },
      );
      sent.push(row.id);
    } catch (problem: any) {
      // 404/410 = the phone removed the subscription. Anything else: try again next run.
      if (problem?.statusCode === 404 || problem?.statusCode === 410) dead.push(row.id);
      // Anything else (for example 403: the phone registered with a different key) is reported below.
      else failed.push({ status: problem?.statusCode ?? 0, reason: String(problem?.body ?? problem?.message ?? "").slice(0, 200) });
    }
  }));
  if (sent.length) await supabase.rpc("first_things_reminders_sent", { ids: sent });
  if (dead.length) await supabase.rpc("first_things_reminders_drop", { ids: dead });
  return Response.json({ sent: sent.length, removed: dead.length, failed, config: failed.length ? configCheck() : undefined });
});
