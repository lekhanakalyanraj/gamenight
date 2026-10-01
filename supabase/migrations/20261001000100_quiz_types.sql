-- Quiz Night (slice 5): the new game kind and its phases. On their own, because Postgres can't use an enum value
-- in the same transaction that adds it.
--   question: a question is open and everyone is answering
--   reveal:   the answer, who got it, and the leaderboard, before the next question

alter type public.game_kind add value 'quiz';
alter type public.game_phase add value 'question';
alter type public.game_phase add value 'reveal';
