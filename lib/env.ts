/**
 * Environment access.
 *
 * Server secrets are read through getters rather than module-level constants so
 * that a missing variable fails at the point of use — a build or an unrelated
 * page should not fall over because, say, the Resend key isn't set yet.
 */

function requireServer(name: string): string {
  if (typeof window !== "undefined") {
    throw new Error(`${name} is a server secret and was read in the browser`);
  }
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// NEXT_PUBLIC_ vars must be referenced literally for Next to inline them.
export const publicEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
};

export const serverEnv = {
  get supabaseServiceRoleKey() {
    return requireServer("SUPABASE_SERVICE_ROLE_KEY");
  },
  get anthropicApiKey() {
    return requireServer("ANTHROPIC_API_KEY");
  },
  get resendApiKey() {
    return requireServer("RESEND_API_KEY");
  },
  get emailFrom() {
    return process.env.EMAIL_FROM ?? "Pub Quiz Brain <onboarding@resend.dev>";
  },
  get cronSecret() {
    return requireServer("CRON_SECRET");
  },
};

/** Absolute origin, for magic-link redirects and links inside emails. */
export function siteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercel) return `https://${vercel}`;
  return "http://localhost:3000";
}
