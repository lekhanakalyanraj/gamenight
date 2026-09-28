import { Card, Page } from "@/components/ui";
import { isRoomCode } from "@/lib/validate";

import { JoinForm } from "./join-form";

export default async function JoinPage({ searchParams }: PageProps<"/join">) {
  const { code } = await searchParams;
  const prefill = typeof code === "string" && isRoomCode(code) ? code.toUpperCase() : "";
  return (
    <Page>
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight">Join a game</h1>
        <p className="text-muted">Enter the code on the TV. No account needed.</p>
      </header>
      <Card>
        <JoinForm code={prefill} />
      </Card>
    </Page>
  );
}
