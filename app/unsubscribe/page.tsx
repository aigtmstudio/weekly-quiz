import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ done?: string; error?: string }>;
}) {
  const { done } = await searchParams;

  return (
    <div className="mx-auto max-w-md">
      <h1 className="font-serif text-3xl">
        {done ? "Unsubscribed" : "That link didn’t work"}
      </h1>
      <p className="mt-3 leading-relaxed text-muted">
        {done
          ? "No more email. Your account and your quiz history are untouched — the site still works as before."
          : "The link may have been mangled in transit. You can turn email off in settings instead."}
      </p>
      <p className="mt-6 text-sm">
        <Link href="/settings" className="text-accent underline">
          Email settings
        </Link>
      </p>
    </div>
  );
}
