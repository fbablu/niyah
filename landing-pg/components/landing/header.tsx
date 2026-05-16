import Link from "next/link";
import { Github } from "lucide-react";
import { Button } from "@/components/ui/button";

export function Header() {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link
          href="/"
          className="text-2xl font-bold tracking-tight text-foreground"
        >
          Niyah
        </Link>

        <div className="flex items-center gap-2 sm:gap-3">
          <a
            href="https://github.com/fbablu/niyah"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="View source on GitHub"
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-white hover:text-foreground"
          >
            <Github className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">Source</span>
          </a>

          <Button size="sm" asChild>
            <a
              href="https://forms.gle/xC4qzpmwWwDD7Z5VA"
              target="_blank"
              rel="noopener noreferrer"
            >
              Join the Waitlist
            </a>
          </Button>
        </div>
      </div>
    </header>
  );
}
