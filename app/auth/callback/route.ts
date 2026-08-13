import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";

import { ensureMember } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Where the magic link lands.
 *
 * Handles both shapes Supabase can send: `?code=` (PKCE, the default for the
 * SSR client) and `?token_hash=&type=` (used when the email template is
 * customised). Supporting both means changing the template later doesn't break
 * sign-in.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const next = url.searchParams.get("next") ?? "/";
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;

  const supabase = await createClient();

  let failed = true;
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    failed = Boolean(error);
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    failed = Boolean(error);
  }

  if (failed) {
    return NextResponse.redirect(new URL("/login?error=link", url.origin));
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Verified, but membership is what actually grants access.
  if (!user || !(await ensureMember(user))) {
    await supabase.auth.signOut();
    return NextResponse.redirect(new URL("/login?error=not-a-member", url.origin));
  }

  const destination = next.startsWith("/") ? next : "/";
  return NextResponse.redirect(new URL(destination, url.origin));
}
