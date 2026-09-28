import { ButtonLink, Page } from "@/components/ui";

export default function Home() {
  return (
    <Page>
      <div className="flex flex-1 flex-col justify-center gap-8">
        <header className="flex flex-col gap-3">
          <p className="font-mono text-sm tracking-widest text-accent">GAMENIGHT</p>
          <h1 className="text-4xl font-semibold leading-tight tracking-tight">
            The room on the TV. Everyone on their phones. An AI host running the games.
          </h1>
          <p className="text-muted">Mafia, Undercover, Quiz Night and Heads Up, narrated out loud.</p>
        </header>
        <div className="flex flex-col gap-3">
          <ButtonLink href="/join">Join a game</ButtonLink>
          <ButtonLink href="/host" variant="secondary">Host a game night</ButtonLink>
        </div>
      </div>
    </Page>
  );
}
