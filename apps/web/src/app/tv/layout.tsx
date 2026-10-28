import type { ReactNode } from "react";

/** The TV is the carbon display case: the whole screen is the dark band the design reserves for the live thing. */
export default function TvLayout({ children }: { children: ReactNode }) {
  return (
    <div data-theme="carbon" className="flex min-h-dvh flex-1 flex-col">
      {children}
    </div>
  );
}
