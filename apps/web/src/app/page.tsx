import Link from "next/link";

import { ButtonLink, Label, Page, Wordmark } from "@/components/ui";

const GAMES = [
  ["01", "Undercover", "One word, one impostor, and a vote."],
  ["02", "Quiz Night", "Rounds on your phones, topics you pick."],
  ["03", "Heads Up", "The word's on the TV. Everyone shouts clues."],
] as const;

export default function Home() {
  return (
    <Page>
      <Wordmark />
      <header className="flex flex-col gap-4">
        <h1 className="text-[2.5rem] leading-[1.08] tracking-tight">
          The room on the TV. Everyone on their phones. An AI host running the games.
        </h1>
        <p className="text-muted">Narrated out loud, made for a living room.</p>
      </header>
      <section className="flex flex-col">
        <Label className="border-b border-ink pb-2">Three games</Label>
        {GAMES.map(([n, name, line]) => (
          <div key={n} className="grid grid-cols-[2.5rem_1fr] gap-x-2 border-b border-border py-3">
            <span className="font-mono text-sm text-muted">{n}</span>
            <span className="text-lg">{name}</span>
            <span />
            <span className="text-sm text-muted">{line}</span>
          </div>
        ))}
      </section>
      <div className="flex flex-col gap-3">
        <ButtonLink href="/join">Join a game</ButtonLink>
        <ButtonLink href="/host" variant="secondary">Host a game night</ButtonLink>
      </div>
      <p className="text-sm text-muted">
        Setting up the big screen? Open <Link href="/tv" className="text-foreground underline underline-offset-4">/tv</Link> on
        the TV and connect it from the host&apos;s phone.
      </p>
    </Page>
  );
}
