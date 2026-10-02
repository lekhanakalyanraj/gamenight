export type { Database, Json } from "./database";
import type { Database } from "./database";

type Public = Database["public"];
export type Room = Public["Tables"]["rooms"]["Row"];
export type RoomMember = Public["Tables"]["room_members"]["Row"];
export type AgeRating = Public["Enums"]["age_rating"];
export type RoomDisplay = Public["Tables"]["room_displays"]["Row"];
export type HostLine = Public["Tables"]["host_lines"]["Row"];
export type GamePhase = Public["Enums"]["game_phase"];
export type Game = Public["Tables"]["games"]["Row"];
export type GamePlayer = Public["Tables"]["game_players"]["Row"];
export type GameResult = Public["Tables"]["game_results"]["Row"];
export type Secret = Public["Tables"]["secrets"]["Row"];
export type GameAction = Public["Tables"]["game_actions"]["Row"];
export type QuizQuestion = Public["Tables"]["quiz_questions"]["Row"];
export type QuizAnswer = Public["Tables"]["quiz_answers"]["Row"];
export type QuizScore = Public["Tables"]["quiz_scores"]["Row"];
export type HeadsupTurn = Public["Tables"]["headsup_turns"]["Row"];
