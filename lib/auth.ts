import type { User } from "@supabase/supabase-js";

import { siteUrl } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * Magic-link sign-in.
 *
 * Two invariants: an address that is not on the allowlist never receives an
 * email, and the caller can never tell the difference. Everything here returns
 * the same result whether the address is known, rate-limited, or rejected.
 */

const MAX_PER_EMAIL_PER_HOUR = 5;
const MAX_PER_IP_PER_HOUR = 10;

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Best-effort client IP behind Vercel's proxy. */
export function clientIp(request: { headers: Headers }): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

async function withinRateLimit(email: string, ip: string): Promise<boolean> {
  const db = createAdminClient();
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  await db.from("pqb_signin_attempts").insert({ email, ip });

  const [byEmail, byIp] = await Promise.all([
    db
      .from("pqb_signin_attempts")
      .select("id", { count: "exact", head: true })
      .eq("email", email)
      .gte("requested_at", since),
    db
      .from("pqb_signin_attempts")
      .select("id", { count: "exact", head: true })
      .eq("ip", ip)
      .gte("requested_at", since),
  ]);

  if ((byEmail.count ?? 0) > MAX_PER_EMAIL_PER_HOUR) return false;
  if (ip !== "unknown" && (byIp.count ?? 0) > MAX_PER_IP_PER_HOUR) return false;
  return true;
}

/**
 * Send a sign-in link, if the address is allowed and not being hammered.
 *
 * Deliberately returns void: the caller must show the same message either way,
 * so the form cannot be used to test who has an account.
 */
export async function requestMagicLink(
  rawEmail: string,
  ip: string,
  next = "/",
): Promise<void> {
  const email = normaliseEmail(rawEmail);
  if (!email.includes("@")) return;

  if (!(await withinRateLimit(email, ip))) return;

  const db = createAdminClient();
  const { data: allowed } = await db
    .from("pqb_allowed_emails")
    .select("email")
    .eq("email", email)
    .maybeSingle();

  if (!allowed) return;

  const supabase = await createClient();
  const redirect = new URL("/auth/callback", siteUrl());
  redirect.searchParams.set("next", next);

  await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirect.toString(), shouldCreateUser: true },
  });
}

/**
 * Make sure a verified user has a membership row.
 *
 * Membership is what grants access, not merely having an auth account — this
 * Supabase project's auth schema is shared with other applications.
 */
export async function ensureMember(user: User): Promise<boolean> {
  const email = normaliseEmail(user.email ?? "");
  if (!email) return false;

  const db = createAdminClient();

  const { data: existing } = await db
    .from("pqb_members")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (existing) return true;

  const { data: allowed } = await db
    .from("pqb_allowed_emails")
    .select("email, display_name")
    .eq("email", email)
    .maybeSingle();
  if (!allowed) return false;

  const { error } = await db.from("pqb_members").insert({
    user_id: user.id,
    email,
    display_name: allowed.display_name,
  });
  if (error && error.code !== "23505") throw error;

  // Default preferences, so the email job has something to read.
  await db
    .from("pqb_preferences")
    .upsert({ user_id: user.id }, { onConflict: "user_id", ignoreDuplicates: true });

  return true;
}
