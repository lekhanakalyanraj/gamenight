import { Card, Page } from "@/components/ui";
import { safeNext } from "@/lib/validate";

import { AuthForm } from "./auth-form";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { next } = await searchParams;
  return (
    <Page>
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight">Host a game night</h1>
        <p className="text-muted">Hosts sign in to create rooms. Players just join with a code.</p>
      </header>
      <Card>
        <AuthForm next={safeNext(typeof next === "string" ? next : undefined)} />
      </Card>
    </Page>
  );
}
