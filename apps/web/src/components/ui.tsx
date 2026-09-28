import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

export function Page({ children }: { children: ReactNode }) {
  return <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-5 py-10">{children}</main>;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-2xl border border-border bg-surface p-5 ${className}`}>{children}</section>;
}

const button = {
  primary: "bg-accent text-accent-ink hover:brightness-110",
  secondary: "border border-border bg-surface-2 text-foreground hover:bg-border",
};

export function Button({ variant = "primary", className = "", ...props }: ComponentProps<"button"> & {
  variant?: keyof typeof button;
}) {
  return (
    <button
      className={`h-11 rounded-xl px-4 font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50 ${button[variant]} ${className}`}
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
    <Link
      href={href}
      className={`flex h-11 items-center justify-center rounded-xl px-4 font-medium transition ${button[variant]}`}
    >
      {children}
    </Link>
  );
}

export function Field({ label, hint, ...props }: ComponentProps<"input"> & { label: string; hint?: string }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="text-muted">{label}</span>
      <input
        className="h-11 rounded-xl border border-border bg-background px-3 text-base text-foreground outline-none placeholder:text-muted/60 focus:border-accent"
        {...props}
      />
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export function Notice({ tone = "error", children }: { tone?: "error" | "info"; children: ReactNode }) {
  if (!children) return null;
  const styles = tone === "error" ? "border-danger/50 text-danger" : "border-accent/50 text-accent";
  return <p role={tone === "error" ? "alert" : "status"} className={`rounded-xl border px-3 py-2 text-sm ${styles}`}>{children}</p>;
}
