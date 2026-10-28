import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

/**
 * A page: one column on a phone. `wide` (the lobby) becomes a two-column grid of cards on a tablet or laptop; a child
 * with `md:col-span-2` spans both.
 */
export function Page({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <main className={`mx-auto flex w-full flex-1 flex-col gap-8 px-5 py-8 ${wide
      ? "max-w-md md:grid md:max-w-5xl md:grid-cols-2 md:items-start md:gap-x-10 md:px-10 lg:py-12"
      : "max-w-md"}`}>
      {children}
    </main>
  );
}

/** The lowercase wordmark, top left of every page, the way the reference's catalogue opens. */
export function Wordmark({ right }: { right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border pb-3">
      <Link href="/" className="text-lg tracking-tight">gamenight</Link>
      {right}
    </div>
  );
}

/** A small mono capital label: what a section, a value or a row is. */
export function Label({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`caps text-xs text-muted ${className}`}>{children}</p>;
}

/** A ruled section: a hairline across the top, an optional label, then the content. No box, no fill. */
export function Card({ children, label, className = "" }: { children: ReactNode; label?: ReactNode; className?: string }) {
  return (
    <section className={`flex flex-col gap-4 border-t border-ink pt-4 ${className}`}>
      {label ? <Label>{label}</Label> : null}
      {children}
    </section>
  );
}

const button = {
  primary: "bg-ink text-background hover:opacity-85",
  secondary: "border border-ink text-foreground hover:bg-surface-2",
  live: "bg-accent text-accent-ink hover:brightness-105",
};

export function Button({ variant = "primary", className = "", ...props }: ComponentProps<"button"> & {
  variant?: keyof typeof button;
}) {
  return (
    <button
      className={`h-12 px-4 text-base transition disabled:opacity-40 ${button[variant]} ${className}`}
      {...props}
    />
  );
}

export function ButtonLink({ href, variant = "primary", children }: {
  href: string;
  variant?: keyof typeof button;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={`flex h-12 items-center justify-between px-4 text-base transition ${button[variant]}`}>
      {children}
      <span aria-hidden className="caps text-xs">→</span>
    </Link>
  );
}

export function Field({ label, hint, className, ...props }: ComponentProps<"input"> & { label: string; hint?: string }) {
  return (
    <label className="flex flex-col gap-2">
      <span className="caps text-xs text-muted">{label}</span>
      <input
        className={className ?? "h-12 border border-ink bg-surface px-3 text-base text-foreground outline-none placeholder:text-muted/60 focus-visible:outline-accent"}
        {...props}
      />
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export function Notice({ tone = "error", children }: { tone?: "error" | "info"; children: ReactNode }) {
  if (!children) return null;
  const styles = tone === "error" ? "border-danger text-danger" : "border-accent text-foreground";
  return <p role={tone === "error" ? "alert" : "status"} className={`border-l-2 py-1 pl-3 text-sm ${styles}`}>{children}</p>;
}
