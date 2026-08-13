"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { clientIp, requestMagicLink } from "@/lib/auth";

export async function sendSignInLink(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const next = String(formData.get("next") ?? "/");

  await requestMagicLink(email, clientIp({ headers: await headers() }), next);

  // Always the same outcome, whether or not the address is registered.
  redirect("/login?sent=1");
}
