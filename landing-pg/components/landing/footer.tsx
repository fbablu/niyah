import Link from "next/link";

export function Footer() {
  return (
    <footer className="border-t border-border bg-secondary/30 px-6 py-12">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-col gap-8 md:flex-row md:items-start md:justify-between">
          {/* Brand */}
          <div className="max-w-xs">
            <Link href="/" className="mb-4 flex items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary">
                <span className="text-lg font-bold text-primary-foreground">
                  N
                </span>
              </div>
              <span className="text-xl font-bold tracking-tight text-foreground">
                Niyah
              </span>
            </Link>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              Focus sessions with real financial stakes. A commitment contract
              app — not a gamble.
            </p>
          </div>

          {/* Links */}
          <div className="flex gap-16">
            <div>
              <p className="mb-3 text-sm font-semibold text-foreground">
                Product
              </p>
              <nav className="flex flex-col gap-2">
                <Link
                  href="#how-it-works"
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  How It Works
                </Link>
                <Link
                  href="#features"
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  Features
                </Link>
                <Link
                  href="#faq"
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  FAQ
                </Link>
              </nav>
            </div>
            <div>
              <p className="mb-3 text-sm font-semibold text-foreground">
                Legal
              </p>
              <nav className="flex flex-col gap-2">
                <Link
                  href="#"
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  Privacy Policy
                </Link>
                <Link
                  href="#"
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  Terms of Service
                </Link>
              </nav>
            </div>
            <div>
              <p className="mb-3 text-sm font-semibold text-foreground">
                Build
              </p>
              <nav className="flex flex-col gap-2">
                <Link
                  href="https://github.com/fbablu/niyah"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  Source on GitHub
                </Link>
              </nav>
            </div>
          </div>
        </div>

        <div className="mt-10 flex flex-col gap-4 border-t border-border pt-8 text-xs text-muted-foreground md:flex-row md:items-center md:justify-between">
          <p>&copy; {new Date().getFullYear()} Niyah. All rights reserved.</p>
          <div className="flex flex-col gap-1 md:flex-row md:items-center md:gap-4">
            <Link
              href="https://github.com/fbablu/niyah"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-foreground"
            >
              View source on GitHub &rarr;
            </Link>
            <p>App Store Category: Productivity &middot; Payments via Stripe</p>
          </div>
        </div>
      </div>
    </footer>
  );
}
