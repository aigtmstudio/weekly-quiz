import type { Metadata } from "next";
import Link from "next/link";
import { Source_Sans_3, Source_Serif_4 } from "next/font/google";

import { createClient } from "@/lib/supabase/server";
import "./globals.css";

const sans = Source_Sans_3({ variable: "--font-sans-stack", subsets: ["latin"] });
const serif = Source_Serif_4({ variable: "--font-serif-stack", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Pub Quiz Brain",
  description: "Five facts a day, and a quiz on whether they stuck.",
};

async function Nav() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <header className="border-b border-line">
      <nav className="mx-auto flex max-w-2xl items-center gap-5 px-5 py-4 text-sm">
        <Link href="/" className="font-serif text-base font-semibold tracking-tight">
          Pub Quiz Brain
        </Link>
        <div className="ml-auto flex items-center gap-5 text-muted">
          {user ? (
            <>
              <Link href="/history" className="hover:text-foreground">
                History
              </Link>
              <Link href="/settings" className="hover:text-foreground">
                Settings
              </Link>
              <form action="/auth/signout" method="post">
                <button type="submit" className="hover:text-foreground">
                  Sign out
                </button>
              </form>
            </>
          ) : (
            <Link href="/login" className="hover:text-foreground">
              Sign in
            </Link>
          )}
        </div>
      </nav>
    </header>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en-GB"
      className={`${sans.variable} ${serif.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col font-sans">
        <Nav />
        <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-10">{children}</main>
        <footer className="mx-auto w-full max-w-2xl px-5 py-8 text-xs text-muted">
          Facts are written by Claude and published automatically.
        </footer>
      </body>
    </html>
  );
}
