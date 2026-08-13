import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

import { savePreferences } from "./actions";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string }>;
}) {
  const { saved } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/settings");

  const { data: preferences } = await supabase
    .from("pqb_preferences")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  const current = preferences ?? {
    daily_email: true,
    weekly_email: true,
    monthly_email: true,
    send_hour: 7,
    unsubscribed: false,
    undeliverable: false,
  };

  return (
    <div className="mx-auto max-w-md">
      <h1 className="font-serif text-3xl">Settings</h1>
      <p className="mt-1 text-sm text-muted">{user.email}</p>

      {saved && <p className="mt-4 text-sm text-correct">Saved.</p>}

      {current.undeliverable && (
        <p className="mt-4 rounded-md border border-line bg-surface p-3 text-sm text-wrong">
          Email to this address bounced, so sending is paused. Re-save these settings
          to try again.
        </p>
      )}

      <form action={savePreferences} className="mt-6 flex flex-col gap-4">
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-sm text-muted">Send me</legend>
          <Toggle name="daily_email" label="The daily facts" checked={current.daily_email} />
          <Toggle name="weekly_email" label="The weekly quiz" checked={current.weekly_email} />
          <Toggle
            name="monthly_email"
            label="The monthly quiz"
            checked={current.monthly_email}
          />
        </fieldset>

        <p className="text-sm text-muted">
          Email goes out first thing each morning, London time.
        </p>

        <Toggle
          name="unsubscribed"
          label="Stop all email (keeps the account)"
          checked={current.unsubscribed}
        />

        <button
          type="submit"
          className="mt-2 self-start rounded-md bg-accent px-4 py-2 font-medium text-background"
        >
          Save
        </button>
      </form>
    </div>
  );
}

function Toggle({
  name,
  label,
  checked,
}: {
  name: string;
  label: string;
  checked: boolean;
}) {
  return (
    <label className="flex items-center gap-3">
      <input
        type="checkbox"
        name={name}
        defaultChecked={checked}
        className="size-4 accent-[var(--accent)]"
      />
      <span>{label}</span>
    </label>
  );
}
