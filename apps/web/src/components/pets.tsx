import type { Game } from "@gamenight/db-types";

/**
 * The TV's pets, after Colab's corgi and kitty modes: a dog and a cat in pixels along the bottom of the screen,
 * reacting to the game. The dog trots and the cat naps in the lobby; both sit and watch while a question is open, hop
 * at a reveal, and chase each other at the podium.
 *
 * Drawn here (no outside art), as squares in an SVG. All the motion is CSS (globals.css): two walk frames swapped
 * with steps(), and transforms. No JavaScript animation loop, so they cost next to nothing on a TV's weak CPU. Off
 * under "reduce motion" (they stand still), and the host can switch them off. Decorative: hidden from screen readers.
 */

export type PetMood = "lobby" | "watch" | "hop" | "chase" | "walk";

/** What the pets do, from the game on screen (null: the lobby). */
export function petMood(game: Game | null, revealed = false): PetMood {
  if (!game) return "lobby";
  if (game.phase === "ended") return "chase";
  if (game.phase === "reveal" || game.phase === "recap" || revealed) return "hop";
  if (["question", "vote", "guess", "guessing"].includes(game.phase)) return "watch";
  return "walk";
}

// 16 x 10 pixels, facing right. d: coat, w: white, k: eyes and nose. The last two rows are the legs.
const DOG = [
  "...........d.d..",
  "..........ddddd.",
  "..........dddkdk",
  "d.........ddddww",
  "dd.ddddddddddw..",
  ".dddddddddddddd.",
  ".ddwwwwwwwwwdd..",
  "..dwwwwwwwwwd...",
];
const DOG_LEGS = [["..dd.d....dd.d..", "..dd.d....dd.d.."], ["...dd.d..d.dd...", "..d...dd.dd..d.."]];

// g: fur, s: stripes, k: eyes and nose.
const CAT = [
  "..........g...g.",
  "..........ggggg.",
  "g.........gkggk.",
  "g.........ggkgg.",
  ".g.gggggggggggg.",
  "..gsgsgsggggggg.",
  "..gggggggggggg..",
  "..ggggggggggg...",
];
const CAT_LEGS = [["..gg.g....gg.g..", "..gg.g....gg.g.."], ["...gg.g..g.gg...", "..g...gg.gg..g.."]];

const FILL: Record<string, string> = { d: "pet-coat", w: "pet-white", k: "pet-dark", g: "pet-fur", s: "pet-stripe" };

function Pixels({ rows }: { rows: string[] }) {
  return rows.flatMap((row, y) => [...row].map((c, x) => (c === "." ? null : (
    <rect key={`${x}-${y}`} x={x} y={y} width={1.02} height={1.02} className={FILL[c]} />
  ))));
}

function Sprite({ body, legs, className }: { body: string[]; legs: string[][]; className: string }) {
  return (
    <svg viewBox="0 0 16 10" shapeRendering="crispEdges" className={`pet ${className}`}>
      <g className="pet-frame-a"><Pixels rows={[...body, ...legs[0]]} /></g>
      <g className="pet-frame-b"><Pixels rows={[...body, ...legs[1]]} /></g>
    </svg>
  );
}

export function Pets({ on, mood }: { on: boolean; mood: PetMood }) {
  if (!on) return null;
  return (
    <div data-testid="pets" data-mood={mood} aria-hidden className={`pets pets-${mood}`}>
      <Sprite body={DOG} legs={DOG_LEGS} className="pet-dog" />
      <Sprite body={CAT} legs={CAT_LEGS} className="pet-cat" />
      {mood === "lobby" ? <span className="pet-zzz">z</span> : null}
    </div>
  );
}
