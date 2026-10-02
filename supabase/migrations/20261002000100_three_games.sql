-- The plan is three games for now: Undercover, Quiz Night and Heads Up. Mafia leaves the catalogue, so the AI host
-- stops suggesting a game nobody can play. (Nothing references it: no game kind, rules or content was ever built.)

delete from catalog.games where slug = 'mafia';
