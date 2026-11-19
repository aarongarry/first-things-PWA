// Admin-only helper for the "Maintain Users" page.
//
// Why this exists: creating or deleting a *login* (a Supabase Auth account) needs the
// service-role key, and that key must never be in browser code. So the browser calls
// this function with the admin's own session token, and the function does the Auth
// part on the server. The permission check itself lives in SQL (public.is_admin()),
// so the rules are in one place.
//
// Deploy:  npx supabase functions deploy admin-users
// (SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided automatically.)
import { createClient } from "npm:@supabase/supabase-js@2";

const url = Deno.env.get("SUPABASE_URL")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// CORS: the page is served from CloudFront (a different origin than Supabase), so the
// browser sends a preflight request first and needs these headers on every response.
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
// Small helper so every reply is JSON with the CORS headers attached.
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "Use POST" });

  // Two clients: one that acts AS THE CALLER (so SQL sees auth.uid()), and one with the
  // service role (the only one allowed to touch Auth accounts).
  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const asService = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Gatekeeper: only a real, listed admin gets past this line.
  const { data: isAdmin } = await asCaller.rpc("is_admin");
  if (isAdmin !== true) return reply(403, { error: "Admin access required" });

  let body: Record<string, any>;
  try { body = await req.json(); } catch { return reply(400, { error: "Send JSON" }); }

  try {
    // ---- CREATE: new login + matching row in the user table --------------------------
    if (body.action === "create") {
      const email = String(body.email ?? "").trim().toLowerCase();
      const password = String(body.password ?? "");
      if (!email.includes("@")) return reply(400, { error: "Enter a valid e-mail" });
      if (password.length < 8) return reply(400, { error: "Password must be at least 8 characters" });

      // email_confirm: true lets the person sign in right away (no confirmation e-mail).
      const created = await asService.auth.admin.createUser({ email, password, email_confirm: true });
      if (created.error) return reply(400, { error: created.error.message });

      // Save the app-side row through the guarded SQL function, linked to the new login.
      const saved = await asCaller.rpc("admin_save_user", {
        p_id: null, p_name: body.name ?? "", p_phone: body.phone ?? "", p_auth_user_id: created.data.user.id,
      });
      if (saved.error) {
        // Roll back the login so we never leave an account without a matching row.
        await asService.auth.admin.deleteUser(created.data.user.id);
        return reply(400, { error: saved.error.message });
      }
      return reply(200, { id: saved.data });
    }

    // ---- UPDATE LOGIN: change e-mail and/or password (name/phone use the SQL function) ---
    if (body.action === "update") {
      const patch: Record<string, unknown> = {};
      if (body.email) { patch.email = String(body.email).trim().toLowerCase(); patch.email_confirm = true; }
      if (body.password) {
        if (String(body.password).length < 8) return reply(400, { error: "Password must be at least 8 characters" });
        patch.password = String(body.password);
      }
      if (!body.auth_user_id || Object.keys(patch).length === 0) return reply(400, { error: "Nothing to update" });
      const updated = await asService.auth.admin.updateUserById(String(body.auth_user_id), patch);
      if (updated.error) return reply(400, { error: updated.error.message });
      return reply(200, { ok: true });
    }

    // ---- DELETE: remove the app data (SQL), then the login ------------------------------
    if (body.action === "delete") {
      // The SQL function deletes tasks/goals/daily/user rows and refuses self-deletion.
      const removed = await asCaller.rpc("admin_delete_user", { p_id: body.id });
      if (removed.error) return reply(400, { error: removed.error.message });
      if (removed.data) {
        const gone = await asService.auth.admin.deleteUser(removed.data as string);
        if (gone.error) return reply(400, { error: gone.error.message });
      }
      return reply(200, { ok: true });
    }

    return reply(400, { error: "Unknown action" });
  } catch (error) {
    return reply(500, { error: error instanceof Error ? error.message : "Unexpected error" });
  }
});
