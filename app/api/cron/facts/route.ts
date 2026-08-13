import { NextResponse } from "next/server";

import { today } from "@/lib/dates";
import { publishFacts } from "@/lib/facts";
import { isAuthorisedCron, runOnce } from "@/lib/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!isAuthorisedCron(request)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const date = today();

  try {
    const result = await runOnce("facts", date, async () => {
      const facts = await publishFacts(date);
      return `${facts.length} facts for ${date}`;
    });
    return NextResponse.json({ job: "facts", date, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("facts cron failed", error);
    return NextResponse.json({ job: "facts", date, error: message }, { status: 500 });
  }
}
