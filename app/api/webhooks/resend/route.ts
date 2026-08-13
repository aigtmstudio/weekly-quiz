import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Resend bounce and complaint webhook.
 *
 * A hard bounce or a spam complaint marks the address undeliverable and stops
 * sending to it. Saving settings clears the flag, which is the deliberate act
 * needed to try again.
 *
 * Signatures follow the Svix scheme Resend uses. Verified by hand rather than
 * pulling in the svix package for twenty lines of HMAC.
 */

const STOP_EVENTS = new Set(["email.bounced", "email.complained"]);

function verify(secret: string, headers: Headers, payload: string): boolean {
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signatures = headers.get("svix-signature");
  if (!id || !timestamp || !signatures) return false;

  // Reject anything more than five minutes old, to blunt replay.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${payload}`)
    .digest("base64");
  const expectedBuffer = Buffer.from(expected);

  return signatures.split(" ").some((entry) => {
    const value = entry.split(",")[1];
    if (!value) return false;
    const given = Buffer.from(value);
    return given.length === expectedBuffer.length && timingSafeEqual(given, expectedBuffer);
  });
}

export async function POST(request: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Webhook not configured" }, { status: 501 });
  }

  const payload = await request.text();
  if (!verify(secret, request.headers, payload)) {
    return NextResponse.json({ error: "Bad signature" }, { status: 401 });
  }

  const event = JSON.parse(payload) as {
    type?: string;
    data?: { to?: string[] | string };
  };

  if (!event.type || !STOP_EVENTS.has(event.type)) {
    return NextResponse.json({ ignored: event.type ?? null });
  }

  const to = Array.isArray(event.data?.to) ? event.data?.to[0] : event.data?.to;
  if (!to) return NextResponse.json({ ignored: "no recipient" });

  const db = createAdminClient();
  const { data: member } = await db
    .from("pqb_members")
    .select("user_id")
    .eq("email", to.toLowerCase())
    .maybeSingle();

  if (!member) return NextResponse.json({ ignored: "unknown recipient" });

  await db.from("pqb_preferences").upsert(
    {
      user_id: member.user_id,
      undeliverable: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  return NextResponse.json({ stopped: true });
}
