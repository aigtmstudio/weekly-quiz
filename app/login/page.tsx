import { sendSignInLink } from "./actions";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  link: "That link didn't work — it may have expired or already been used. Ask for a new one.",
  "not-a-member": "That account isn't set up for Pub Quiz Brain.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string; next?: string }>;
}) {
  const { sent, error, next } = await searchParams;

  return (
    <div className="mx-auto max-w-md">
      <h1 className="font-serif text-3xl">Sign in</h1>

      {error && ERRORS[error] && (
        <p className="mt-4 rounded-md border border-line bg-surface p-3 text-sm text-wrong">
          {ERRORS[error]}
        </p>
      )}

      {sent ? (
        <p className="mt-4 leading-relaxed">
          If that address has an account, a sign-in link is on its way. It works once
          and expires shortly, so open it on this device.
        </p>
      ) : (
        <>
          <p className="mt-2 leading-relaxed text-muted">
            No password. Put in your email address and you&rsquo;ll get a link.
          </p>
          <form action={sendSignInLink} className="mt-6 flex flex-col gap-3">
            <input type="hidden" name="next" value={next ?? "/"} />
            <label htmlFor="email" className="text-sm text-muted">
              Email address
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              autoFocus
              className="rounded-md border border-line bg-surface px-3 py-2 outline-none focus:border-accent"
            />
            <button
              type="submit"
              className="mt-2 rounded-md bg-accent px-4 py-2 font-medium text-background"
            >
              Send me a link
            </button>
          </form>
        </>
      )}
    </div>
  );
}
