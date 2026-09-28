-- One schema and one role per service, so each service can reach only its own data.
--
--   dispatcher -> dispatch     (outbox cursor and timers, from slice 2)
--   voice      -> narration    (audio jobs, from slice 4)
--   catalog    -> catalog      (the game catalogue, served over HTTP and MCP from slice 9)
--
-- The roles are created without LOGIN: each environment grants a login and password out of band,
-- so no credential ever lives in the repo. None of these schemas is exposed by the Data API.

create role dispatcher_svc nologin;
create role voice_svc nologin;
create role catalog_svc nologin;

create schema dispatch;
create schema narration;
create schema catalog;
revoke all on schema dispatch, narration, catalog from public;

grant usage on schema dispatch to dispatcher_svc;
grant usage on schema narration to voice_svc;
grant usage on schema catalog to catalog_svc;

-- The catalogue starts with the four games gamenight runs. Read-only for the catalog service.
create table catalog.games (
  slug text primary key check (slug ~ '^[a-z][a-z-]*$'),
  name text not null,
  min_players smallint not null check (min_players between 3 and 16),
  max_players smallint not null check (max_players between 3 and 16),
  minutes smallint not null check (minutes > 0),
  summary text not null,
  check (min_players <= max_players)
);
alter table catalog.games enable row level security;
create policy "the catalog service reads the catalogue" on catalog.games
  for select to catalog_svc using (true);
grant select on catalog.games to catalog_svc;

insert into catalog.games (slug, name, min_players, max_players, minutes, summary) values
  ('undercover', 'Undercover (Mr. White)', 3, 16, 20,
   'Everyone gets a word, except the undercover players (a close word) and Mr. White (none). Give clues out loud, then vote.'),
  ('mafia', 'Mafia', 5, 16, 40,
   'A spooky storyteller runs the village. Mafia strike at night; the village votes by day.'),
  ('quiz-night', 'Quiz Night', 3, 16, 25,
   'Mixed rounds on your phones, topics picked by the players, and difficulty that keeps it close.'),
  ('heads-up', 'Heads Up', 3, 16, 15,
   'The guesser turns away from the TV; everyone else gives clues for the word on screen.');
