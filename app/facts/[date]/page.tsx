import Link from "next/link";
import { notFound } from "next/navigation";

import { FactList } from "@/components/fact-card";
import { addDays, formatLong, today } from "@/lib/dates";
import { createClient } from "@/lib/supabase/server";
import type { Fact } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function FactsForDatePage({
  params,
}: {
  params: Promise<{ date: string }>;
}) {
  const { date } = await params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) notFound();

  const supabase = await createClient();
  const { data: facts } = await supabase
    .from("pqb_facts")
    .select("*")
    .eq("publish_date", date)
    .order("position");

  const current = today();

  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="font-serif text-3xl">{formatLong(date)}</h1>
        <nav className="mt-2 flex gap-4 text-sm text-muted">
          <Link href={`/facts/${addDays(date, -1)}`} className="hover:text-foreground">
            ← earlier
          </Link>
          {date < current && (
            <Link href={`/facts/${addDays(date, 1)}`} className="hover:text-foreground">
              later →
            </Link>
          )}
          <Link href="/" className="ml-auto hover:text-foreground">
            today
          </Link>
        </nav>
      </header>

      {facts && facts.length > 0 ? (
        <FactList facts={facts as Fact[]} />
      ) : (
        <p className="text-muted">Nothing was published on this day.</p>
      )}
    </div>
  );
}
