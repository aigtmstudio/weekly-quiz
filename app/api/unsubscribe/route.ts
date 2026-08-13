import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { verifyUnsubscribeToken } from "@/lib/unsubscribe";

export const dynamic = "force-dynamic";

async function unsubscribe(token: string | null): Promise<boolean> {
  if (!token) return false;
  const userId = verifyUnsubscribeToken(token);
  if (!userId) return false;

  const db = createAdminClient();
  const { error } = await db
    .from("pqb_preferences")
    .upsert(
      { user_id: userId, unsubscribed: true, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
  return !error;
}

/** Someone clicking the link in the email body. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const ok = await unsubscribe(url.searchParams.get("token"));
  return NextResponse.redirect(
    new URL(ok ? "/unsubscribe?done=1" : "/unsubscribe?error=1", url.origin),
  );
}

/** RFC 8058 one-click, sent by the mail client itself. */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const ok = await unsubscribe(url.searchParams.get("token"));
  return NextResponse.json({ unsubscribed: ok }, { status: ok ? 200 : 400 });
}
