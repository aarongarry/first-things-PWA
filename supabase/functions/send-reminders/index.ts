// Sends the daily "you still have first things left" push notifications.
// Run every 5 minutes by Supabase Cron (see README → Task reminders).
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT")!,
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

Deno.serve(async (request) => {
  // Deployed with --no-verify-jwt, so this shared secret is the only way in.
  if (request.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) {
    return new Response("Forbidden", { status: 403 });
  }
  const { data, error } = await supabase.rpc("first_things_due_reminders");
  if (error) return new Response(error.message, { status: 500 });

  const sent: string[] = [];
  const dead: string[] = [];
  await Promise.all((data ?? []).map(async (row: any) => {
    const left = row.remaining as number;
    const payload = JSON.stringify({
      title: "First Things",
      body: `${left} first thing${left === 1 ? "" : "s"} left. A small step now, a little freedom later.`,
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
    }
  }));
  if (sent.length) await supabase.rpc("first_things_reminders_sent", { ids: sent });
  if (dead.length) await supabase.rpc("first_things_reminders_drop", { ids: dead });
  return Response.json({ sent: sent.length, removed: dead.length });
});
