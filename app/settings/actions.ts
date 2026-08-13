"use server";

import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

export async function savePreferences(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/settings");

  await supabase.from("pqb_preferences").upsert(
    {
      user_id: user.id,
      daily_email: formData.get("daily_email") === "on",
      weekly_email: formData.get("weekly_email") === "on",
      monthly_email: formData.get("monthly_email") === "on",
      unsubscribed: formData.get("unsubscribed") === "on",
      // Saving settings is a deliberate act, so clear a previous bounce.
      undeliverable: false,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  redirect("/settings?saved=1");
}
