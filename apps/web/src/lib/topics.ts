/**
 * Topics (Quiz Night) and interests (Heads Up): the suggestions players can tap, and each one's theme colour. A
 * picked topic's text shows in its colour, on the phone and next to the player on the TV; nothing else is coloured.
 * A topic someone typed gets a colour from its name, so it's the same on every screen.
 */

/** Broad suggestions, not tied to any place: pub-quiz staples and what friends are into. Colour: 1 to 12. */
export const SUGGESTIONS = [
  { name: "Movies", colour: 6 },
  { name: "Bollywood", colour: 10 },
  { name: "Hollywood", colour: 7 },
  { name: "Anime", colour: 9 },
  { name: "K-pop & K-drama", colour: 8 },
  { name: "TV & streaming", colour: 11 },
  { name: "Music", colour: 8 },
  { name: "Cricket", colour: 3 },
  { name: "Football", colour: 4 },
  { name: "F1", colour: 1 },
  { name: "Gaming", colour: 7 },
  { name: "Memes & internet", colour: 9 },
  { name: "Food", colour: 1 },
  { name: "Travel", colour: 5 },
  { name: "Space", colour: 12 },
  { name: "Science", colour: 5 },
  { name: "Mythology", colour: 2 },
  { name: "History", colour: 2 },
  { name: "Animals", colour: 4 },
  { name: "General knowledge", colour: 11 },
] as const;

/** Heads Up leans on things you can act out or describe: the same list, with famous people for general knowledge. */
export const INTEREST_SUGGESTIONS = [
  ...SUGGESTIONS.filter((s) => s.name !== "General knowledge"),
  { name: "Famous people", colour: 10 },
] as const;

const COLOURS = 12;

/** A topic's colour number (1 to 12): a suggestion's own, otherwise from its name. */
export function topicColour(topic: string): number {
  const key = topic.trim().toLowerCase();
  const known = INTEREST_SUGGESTIONS.find((s) => s.name.toLowerCase() === key)
    ?? SUGGESTIONS.find((s) => s.name.toLowerCase() === key);
  if (known) return known.colour;
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return (hash % COLOURS) + 1;
}

/** The class that colours a topic's text (see globals.css). */
export function topicClass(topic: string): string {
  return `topic-${topicColour(topic)}`;
}

/** How long a description can be: the database keeps 3 to 160 characters. */
export const CONTEXT_MAX = 160;
