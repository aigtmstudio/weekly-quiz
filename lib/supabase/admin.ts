import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { publicEnv, serverEnv } from "@/lib/env";
import type { Database } from "@/lib/types";

/**
 * Service-role client. Bypasses row-level security entirely.
 *
 * Only the cron routes and the submit handler use this: writing facts,
 * quizzes and questions, and reading the answer columns clients can't see.
 * It must never be constructed in code that reaches the browser — `serverEnv`
 * throws if it is.
 */
export function createAdminClient() {
  return createSupabaseClient<Database>(
    publicEnv.supabaseUrl,
    serverEnv.supabaseServiceRoleKey,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
