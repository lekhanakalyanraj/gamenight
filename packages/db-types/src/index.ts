export type { Database, Json } from "./database";
import type { Database } from "./database";

type Public = Database["public"];
export type Room = Public["Tables"]["rooms"]["Row"];
export type RoomMember = Public["Tables"]["room_members"]["Row"];
export type AgeRating = Public["Enums"]["age_rating"];
export type RoomDisplay = Public["Tables"]["room_displays"]["Row"];
