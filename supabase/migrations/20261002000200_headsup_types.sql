-- Heads Up, slice 6: a new game kind and its phases. (New enum values can't be used in the transaction that adds
-- them, so they come first, on their own.)
--   ready:    the next guesser turns their back to the TV, a few seconds' countdown
--   guessing: the card is on the TV; the room gives clues, the guesser taps Got it or Pass
--   recap:    the turn's cards and score, before the next guesser

alter type public.game_kind add value 'heads_up';
alter type public.game_phase add value 'ready';
alter type public.game_phase add value 'guessing';
alter type public.game_phase add value 'recap';
