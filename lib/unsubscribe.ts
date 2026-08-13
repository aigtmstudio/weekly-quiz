import { createHmac, timingSafeEqual } from "node:crypto";

import { serverEnv, siteUrl } from "@/lib/env";

/**
 * Unsubscribe links that work without signing in — a one-click unsubscribe has
 * to work from the mail client, and a recipient who has lost their session must
 * still be able to stop the email.
 *
 * The token is the user id plus an HMAC. Domain-separated from any other use of
 * CRON_SECRET so a leaked unsubscribe link reveals nothing else.
 */

function sign(userId: string): string {
  return createHmac("sha256", serverEnv.cronSecret)
    .update(`unsubscribe:${userId}`)
    .digest("base64url");
}

export function unsubscribeToken(userId: string): string {
  return `${Buffer.from(userId).toString("base64url")}.${sign(userId)}`;
}

export function verifyUnsubscribeToken(token: string): string | null {
  const [encodedId, signature] = token.split(".");
  if (!encodedId || !signature) return null;

  const userId = Buffer.from(encodedId, "base64url").toString("utf8");
  const expected = Buffer.from(sign(userId));
  const given = Buffer.from(signature);

  if (expected.length !== given.length) return null;
  if (!timingSafeEqual(expected, given)) return null;
  return userId;
}

export function unsubscribeUrl(userId: string): string {
  return `${siteUrl()}/api/unsubscribe?token=${unsubscribeToken(userId)}`;
}
