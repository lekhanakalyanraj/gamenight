
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "graphql_public": {
          Tables: {
            [_ in never]: never
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "graphql":
{ Args: { "extensions"?: Json,"operationName"?: string,"query"?: string,"variables"?: Json }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            "display_pairings": {
                  Row: {
                    "code": string,"expires_at": string,"user_id": string
                  }
                  Insert: {
                    "code": string,"expires_at"?: string,"user_id": string
                  }
                  Update: {
                    "code"?: string,"expires_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"game_actions": {
                  Row: {
                    "created_at": string,"game_id": string,"id": string,"kind": string,"member_id": string,"payload": NonNullable<Json>,"room_id": string,"round": number,"step": number
                  }
                  Insert: {
                    "created_at"?: string,"game_id": string,"id": string,"kind": string,"member_id": string,"payload"?: NonNullable<Json>,"room_id": string,"round": number,"step": number
                  }
                  Update: {
                    "created_at"?: string,"game_id"?: string,"id"?: string,"kind"?: string,"member_id"?: string,"payload"?: NonNullable<Json>,"room_id"?: string,"round"?: number,"step"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "game_actions_game_id_fkey"
      columns: ["game_id"]
isOneToOne: false
      referencedRelation: "games"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "game_actions_member_id_fkey"
      columns: ["member_id"]
isOneToOne: false
      referencedRelation: "room_members"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "game_actions_room_id_fkey"
      columns: ["room_id"]
isOneToOne: false
      referencedRelation: "rooms"
      referencedColumns: ["id"]
    }
                  ]
                },"game_players": {
                  Row: {
                    "alive": boolean,"eliminated_round": number | null,"game_id": string,"member_id": string,"revealed_role": string | null,"room_id": string,"seat": number
                  }
                  Insert: {
                    "alive"?: boolean,"eliminated_round"?: number | null,"game_id": string,"member_id": string,"revealed_role"?: string | null,"room_id": string,"seat": number
                  }
                  Update: {
                    "alive"?: boolean,"eliminated_round"?: number | null,"game_id"?: string,"member_id"?: string,"revealed_role"?: string | null,"room_id"?: string,"seat"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "game_players_game_id_fkey"
      columns: ["game_id"]
isOneToOne: false
      referencedRelation: "games"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "game_players_member_id_fkey"
      columns: ["member_id"]
isOneToOne: false
      referencedRelation: "room_members"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "game_players_room_id_fkey"
      columns: ["room_id"]
isOneToOne: false
      referencedRelation: "rooms"
      referencedColumns: ["id"]
    }
                  ]
                },"game_results": {
                  Row: {
                    "created_at": string,"eliminated": string | null,"game_id": string,"id": string,"kind": string,"overruled": boolean | null,"revealed_role": string | null,"room_id": string,"round": number,"step": number,"tie": boolean,"tied": (string)[] | null,"verdict": boolean | null,"votes": Json | null
                  }
                  Insert: {
                    "created_at"?: string,"eliminated"?: string | null,"game_id": string,"id"?: string,"kind": string,"overruled"?: boolean | null,"revealed_role"?: string | null,"room_id": string,"round": number,"step": number,"tie"?: boolean,"tied"?: (string)[] | null,"verdict"?: boolean | null,"votes"?: Json | null
                  }
                  Update: {
                    "created_at"?: string,"eliminated"?: string | null,"game_id"?: string,"id"?: string,"kind"?: string,"overruled"?: boolean | null,"revealed_role"?: string | null,"room_id"?: string,"round"?: number,"step"?: number,"tie"?: boolean,"tied"?: (string)[] | null,"verdict"?: boolean | null,"votes"?: Json | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "game_results_eliminated_fkey"
      columns: ["eliminated"]
isOneToOne: false
      referencedRelation: "room_members"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "game_results_game_id_fkey"
      columns: ["game_id"]
isOneToOne: false
      referencedRelation: "games"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "game_results_room_id_fkey"
      columns: ["room_id"]
isOneToOne: false
      referencedRelation: "rooms"
      referencedColumns: ["id"]
    }
                  ]
                },"games": {
                  Row: {
                    "config": NonNullable<Json>,"created_at": string,"ended_at": string | null,"guesser": string | null,"id": string,"judgement": Json | null,"kind": Database["public"]['Enums']["game_kind"],"moves_in": number,"paused_at": string | null,"paused_phase_left": string | null,"paused_turn_left": string | null,"phase": Database["public"]['Enums']["game_phase"],"phase_deadline": string | null,"resolved": boolean,"reveal": Json | null,"revoted": boolean,"room_id": string,"round": number,"settings": NonNullable<Json>,"step": number,"turn_deadline": string | null,"turn_index": number | null,"turn_order": (string)[],"vote_candidates": (string)[] | null,"winner": string | null
                  }
                  Insert: {
                    "config"?: NonNullable<Json>,"created_at"?: string,"ended_at"?: string | null,"guesser"?: string | null,"id"?: string,"judgement"?: Json | null,"kind": Database["public"]['Enums']["game_kind"],"moves_in"?: number,"paused_at"?: string | null,"paused_phase_left"?: string | null,"paused_turn_left"?: string | null,"phase"?: Database["public"]['Enums']["game_phase"],"phase_deadline"?: string | null,"resolved"?: boolean,"reveal"?: Json | null,"revoted"?: boolean,"room_id": string,"round"?: number,"settings"?: NonNullable<Json>,"step"?: number,"turn_deadline"?: string | null,"turn_index"?: number | null,"turn_order"?: (string)[],"vote_candidates"?: (string)[] | null,"winner"?: string | null
                  }
                  Update: {
                    "config"?: NonNullable<Json>,"created_at"?: string,"ended_at"?: string | null,"guesser"?: string | null,"id"?: string,"judgement"?: Json | null,"kind"?: Database["public"]['Enums']["game_kind"],"moves_in"?: number,"paused_at"?: string | null,"paused_phase_left"?: string | null,"paused_turn_left"?: string | null,"phase"?: Database["public"]['Enums']["game_phase"],"phase_deadline"?: string | null,"resolved"?: boolean,"reveal"?: Json | null,"revoted"?: boolean,"room_id"?: string,"round"?: number,"settings"?: NonNullable<Json>,"step"?: number,"turn_deadline"?: string | null,"turn_index"?: number | null,"turn_order"?: (string)[],"vote_candidates"?: (string)[] | null,"winner"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "games_guesser_fkey"
      columns: ["guesser"]
isOneToOne: false
      referencedRelation: "room_members"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "games_room_id_fkey"
      columns: ["room_id"]
isOneToOne: false
      referencedRelation: "rooms"
      referencedColumns: ["id"]
    }
                  ]
                },"headsup_turns": {
                  Row: {
                    "cards": Json | null,"ended_at": string | null,"ends_at": string | null,"game_id": string,"got": number,"member_id": string,"number": number,"passed": number,"room_id": string,"round": number,"shown": number,"started_at": string | null,"step": number
                  }
                  Insert: {
                    "cards"?: Json | null,"ended_at"?: string | null,"ends_at"?: string | null,"game_id": string,"got"?: number,"member_id": string,"number": number,"passed"?: number,"room_id": string,"round": number,"shown"?: number,"started_at"?: string | null,"step": number
                  }
                  Update: {
                    "cards"?: Json | null,"ended_at"?: string | null,"ends_at"?: string | null,"game_id"?: string,"got"?: number,"member_id"?: string,"number"?: number,"passed"?: number,"room_id"?: string,"round"?: number,"shown"?: number,"started_at"?: string | null,"step"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "headsup_turns_game_id_fkey"
      columns: ["game_id"]
isOneToOne: false
      referencedRelation: "games"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "headsup_turns_member_id_fkey"
      columns: ["member_id"]
isOneToOne: false
      referencedRelation: "room_members"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "headsup_turns_room_id_fkey"
      columns: ["room_id"]
isOneToOne: false
      referencedRelation: "rooms"
      referencedColumns: ["id"]
    }
                  ]
                },"host_lines": {
                  Row: {
                    "created_at": string,"event_id": string | null,"id": string,"kind": string,"room_id": string,"text": string
                  }
                  Insert: {
                    "created_at"?: string,"event_id"?: string | null,"id"?: string,"kind": string,"room_id": string,"text": string
                  }
                  Update: {
                    "created_at"?: string,"event_id"?: string | null,"id"?: string,"kind"?: string,"room_id"?: string,"text"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "host_lines_room_id_fkey"
      columns: ["room_id"]
isOneToOne: false
      referencedRelation: "rooms"
      referencedColumns: ["id"]
    }
                  ]
                },"profiles": {
                  Row: {
                    "created_at": string,"display_name": string,"id": string
                  }
                  Insert: {
                    "created_at"?: string,"display_name": string,"id": string
                  }
                  Update: {
                    "created_at"?: string,"display_name"?: string,"id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"quiz_answers": {
                  Row: {
                    "action_id": string,"answer": NonNullable<Json>,"answered_at": string,"correct": boolean | null,"game_id": string,"joker": boolean,"member_id": string,"number": number,"points": number | null,"room_id": string
                  }
                  Insert: {
                    "action_id": string,"answer": NonNullable<Json>,"answered_at"?: string,"correct"?: boolean | null,"game_id": string,"joker"?: boolean,"member_id": string,"number": number,"points"?: number | null,"room_id": string
                  }
                  Update: {
                    "action_id"?: string,"answer"?: NonNullable<Json>,"answered_at"?: string,"correct"?: boolean | null,"game_id"?: string,"joker"?: boolean,"member_id"?: string,"number"?: number,"points"?: number | null,"room_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "quiz_answers_game_id_fkey"
      columns: ["game_id"]
isOneToOne: false
      referencedRelation: "games"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "quiz_answers_member_id_fkey"
      columns: ["member_id"]
isOneToOne: false
      referencedRelation: "room_members"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "quiz_answers_room_id_fkey"
      columns: ["room_id"]
isOneToOne: false
      referencedRelation: "rooms"
      referencedColumns: ["id"]
    }
                  ]
                },"quiz_questions": {
                  Row: {
                    "answer": Json | null,"difficulty": number,"for_member": string | null,"game_id": string,"image_credit": Json | null,"image_path": string | null,"kind": string,"number": number,"opened_at": string,"options": Json | null,"prompt": string,"results": Json | null,"revealed_at": string | null,"room_id": string,"round": number,"seconds": number,"source_url": string | null,"step": number,"topic": string,"unit": string | null
                  }
                  Insert: {
                    "answer"?: Json | null,"difficulty": number,"for_member"?: string | null,"game_id": string,"image_credit"?: Json | null,"image_path"?: string | null,"kind": string,"number": number,"opened_at"?: string,"options"?: Json | null,"prompt": string,"results"?: Json | null,"revealed_at"?: string | null,"room_id": string,"round": number,"seconds": number,"source_url"?: string | null,"step": number,"topic": string,"unit"?: string | null
                  }
                  Update: {
                    "answer"?: Json | null,"difficulty"?: number,"for_member"?: string | null,"game_id"?: string,"image_credit"?: Json | null,"image_path"?: string | null,"kind"?: string,"number"?: number,"opened_at"?: string,"options"?: Json | null,"prompt"?: string,"results"?: Json | null,"revealed_at"?: string | null,"room_id"?: string,"round"?: number,"seconds"?: number,"source_url"?: string | null,"step"?: number,"topic"?: string,"unit"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "quiz_questions_for_member_fkey"
      columns: ["for_member"]
isOneToOne: false
      referencedRelation: "room_members"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "quiz_questions_game_id_fkey"
      columns: ["game_id"]
isOneToOne: false
      referencedRelation: "games"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "quiz_questions_room_id_fkey"
      columns: ["room_id"]
isOneToOne: false
      referencedRelation: "rooms"
      referencedColumns: ["id"]
    }
                  ]
                },"quiz_scores": {
                  Row: {
                    "correct": number,"game_id": string,"joker_on": number | null,"jokers": number,"member_id": string,"points": number,"room_id": string
                  }
                  Insert: {
                    "correct"?: number,"game_id": string,"joker_on"?: number | null,"jokers"?: number,"member_id": string,"points"?: number,"room_id": string
                  }
                  Update: {
                    "correct"?: number,"game_id"?: string,"joker_on"?: number | null,"jokers"?: number,"member_id"?: string,"points"?: number,"room_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "quiz_scores_game_id_fkey"
      columns: ["game_id"]
isOneToOne: false
      referencedRelation: "games"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "quiz_scores_member_id_fkey"
      columns: ["member_id"]
isOneToOne: false
      referencedRelation: "room_members"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "quiz_scores_room_id_fkey"
      columns: ["room_id"]
isOneToOne: false
      referencedRelation: "rooms"
      referencedColumns: ["id"]
    }
                  ]
                },"room_displays": {
                  Row: {
                    "id": string,"paired_at": string,"room_id": string,"user_id": string
                  }
                  Insert: {
                    "id"?: string,"paired_at"?: string,"room_id": string,"user_id": string
                  }
                  Update: {
                    "id"?: string,"paired_at"?: string,"room_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "room_displays_room_id_fkey"
      columns: ["room_id"]
isOneToOne: false
      referencedRelation: "rooms"
      referencedColumns: ["id"]
    }
                  ]
                },"room_members": {
                  Row: {
                    "adult_confirmed": boolean,"id": string,"interests": (string)[] | null,"joined_at": string,"left_at": string | null,"nickname": string,"removed_by_host": boolean,"role": Database["public"]['Enums']["member_role"],"room_id": string,"topic": string | null,"user_id": string
                  }
                  Insert: {
                    "adult_confirmed"?: boolean,"id"?: string,"interests"?: (string)[] | null,"joined_at"?: string,"left_at"?: string | null,"nickname": string,"removed_by_host"?: boolean,"role"?: Database["public"]['Enums']["member_role"],"room_id": string,"topic"?: string | null,"user_id": string
                  }
                  Update: {
                    "adult_confirmed"?: boolean,"id"?: string,"interests"?: (string)[] | null,"joined_at"?: string,"left_at"?: string | null,"nickname"?: string,"removed_by_host"?: boolean,"role"?: Database["public"]['Enums']["member_role"],"room_id"?: string,"topic"?: string | null,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "room_members_room_id_fkey"
      columns: ["room_id"]
isOneToOne: false
      referencedRelation: "rooms"
      referencedColumns: ["id"]
    }
                  ]
                },"rooms": {
                  Row: {
                    "age_rating": Database["public"]['Enums']["age_rating"],"closed_at": string | null,"code": string,"created_at": string,"host_id": string,"id": string,"max_players": number,"status": Database["public"]['Enums']["room_status"],"voice": boolean
                  }
                  Insert: {
                    "age_rating"?: Database["public"]['Enums']["age_rating"],"closed_at"?: string | null,"code": string,"created_at"?: string,"host_id": string,"id"?: string,"max_players"?: number,"status"?: Database["public"]['Enums']["room_status"],"voice"?: boolean
                  }
                  Update: {
                    "age_rating"?: Database["public"]['Enums']["age_rating"],"closed_at"?: string | null,"code"?: string,"created_at"?: string,"host_id"?: string,"id"?: string,"max_players"?: number,"status"?: Database["public"]['Enums']["room_status"],"voice"?: boolean
                  }
                  Relationships: [
                    
                  ]
                },"secrets": {
                  Row: {
                    "created_at": string,"game_id": string,"kind": string,"member_id": string,"payload": NonNullable<Json>
                  }
                  Insert: {
                    "created_at"?: string,"game_id": string,"kind": string,"member_id": string,"payload": NonNullable<Json>
                  }
                  Update: {
                    "created_at"?: string,"game_id"?: string,"kind"?: string,"member_id"?: string,"payload"?: NonNullable<Json>
                  }
                  Relationships: [
                    {
      foreignKeyName: "secrets_game_id_fkey"
      columns: ["game_id"]
isOneToOne: false
      referencedRelation: "games"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "secrets_member_id_fkey"
      columns: ["member_id"]
isOneToOne: false
      referencedRelation: "room_members"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "answer_question":
{ Args: { "p_action_id": string,"p_answer": Json,"p_game_id": string }; Returns: {
              "action_id": string,
"answer": NonNullable<Json>,
"answered_at": string,
"correct": boolean | null,
"game_id": string,
"joker": boolean,
"member_id": string,
"number": number,
"points": number | null,
"room_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "quiz_answers"
        isOneToOne: true
        isSetofReturn: false
      } },
"create_room":
{ Args: { "p_age_rating"?: Database["public"]['Enums']["age_rating"],"p_confirm_adult"?: boolean,"p_nickname": string }; Returns: {
              "age_rating": Database["public"]['Enums']["age_rating"],
"closed_at": string | null,
"code": string,
"created_at": string,
"host_id": string,
"id": string,
"max_players": number,
"status": Database["public"]['Enums']["room_status"],
"voice": boolean
            }
                          SetofOptions: {
        from: "*"
        to: "rooms"
        isOneToOne: true
        isSetofReturn: false
      } },
"end_game":
{ Args: { "p_game_id": string }; Returns: {
              "config": NonNullable<Json>,
"created_at": string,
"ended_at": string | null,
"guesser": string | null,
"id": string,
"judgement": Json | null,
"kind": Database["public"]['Enums']["game_kind"],
"moves_in": number,
"paused_at": string | null,
"paused_phase_left": string | null,
"paused_turn_left": string | null,
"phase": Database["public"]['Enums']["game_phase"],
"phase_deadline": string | null,
"resolved": boolean,
"reveal": Json | null,
"revoted": boolean,
"room_id": string,
"round": number,
"settings": NonNullable<Json>,
"step": number,
"turn_deadline": string | null,
"turn_index": number | null,
"turn_order": (string)[],
"vote_candidates": (string)[] | null,
"winner": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "games"
        isOneToOne: true
        isSetofReturn: false
      } },
"extend_phase":
{ Args: { "p_game_id": string,"p_seconds"?: number }; Returns: {
              "config": NonNullable<Json>,
"created_at": string,
"ended_at": string | null,
"guesser": string | null,
"id": string,
"judgement": Json | null,
"kind": Database["public"]['Enums']["game_kind"],
"moves_in": number,
"paused_at": string | null,
"paused_phase_left": string | null,
"paused_turn_left": string | null,
"phase": Database["public"]['Enums']["game_phase"],
"phase_deadline": string | null,
"resolved": boolean,
"reveal": Json | null,
"revoted": boolean,
"room_id": string,
"round": number,
"settings": NonNullable<Json>,
"step": number,
"turn_deadline": string | null,
"turn_index": number | null,
"turn_order": (string)[],
"vote_candidates": (string)[] | null,
"winner": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "games"
        isOneToOne: true
        isSetofReturn: false
      } },
"headsup_live_card":
{ Args: { "p_game_id": string }; Returns: Json
                           },
"headsup_move":
{ Args: { "p_action_id": string,"p_card_no": number,"p_game_id": string,"p_result": string }; Returns: {
              "cards": Json | null,
"ended_at": string | null,
"ends_at": string | null,
"game_id": string,
"got": number,
"member_id": string,
"number": number,
"passed": number,
"room_id": string,
"round": number,
"shown": number,
"started_at": string | null,
"step": number
            }
                          SetofOptions: {
        from: "*"
        to: "headsup_turns"
        isOneToOne: true
        isSetofReturn: false
      } },
"is_guest":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"join_room":
{ Args: { "p_code": string,"p_confirm_adult"?: boolean,"p_nickname": string }; Returns: {
              "adult_confirmed": boolean,
"id": string,
"interests": (string)[] | null,
"joined_at": string,
"left_at": string | null,
"nickname": string,
"removed_by_host": boolean,
"role": Database["public"]['Enums']["member_role"],
"room_id": string,
"topic": string | null,
"user_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "room_members"
        isOneToOne: true
        isSetofReturn: false
      } },
"kick_member":
{ Args: { "p_member_id": string }; Returns: undefined
                           },
"leave_room":
{ Args: { "p_room_id": string }; Returns: undefined
                           },
"new_room_code":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"pair_display":
{ Args: { "p_code": string,"p_room_id": string }; Returns: {
              "id": string,
"paired_at": string,
"room_id": string,
"user_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "room_displays"
        isOneToOne: true
        isSetofReturn: false
      } },
"pause_game":
{ Args: { "p_game_id": string }; Returns: {
              "config": NonNullable<Json>,
"created_at": string,
"ended_at": string | null,
"guesser": string | null,
"id": string,
"judgement": Json | null,
"kind": Database["public"]['Enums']["game_kind"],
"moves_in": number,
"paused_at": string | null,
"paused_phase_left": string | null,
"paused_turn_left": string | null,
"phase": Database["public"]['Enums']["game_phase"],
"phase_deadline": string | null,
"resolved": boolean,
"reveal": Json | null,
"revoted": boolean,
"room_id": string,
"round": number,
"settings": NonNullable<Json>,
"step": number,
"turn_deadline": string | null,
"turn_index": number | null,
"turn_order": (string)[],
"vote_candidates": (string)[] | null,
"winner": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "games"
        isOneToOne: true
        isSetofReturn: false
      } },
"play_joker":
{ Args: { "p_game_id": string }; Returns: {
              "correct": number,
"game_id": string,
"joker_on": number | null,
"jokers": number,
"member_id": string,
"points": number,
"room_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "quiz_scores"
        isOneToOne: true
        isSetofReturn: false
      } },
"remove_display":
{ Args: { "p_display_id": string }; Returns: undefined
                           },
"resume_game":
{ Args: { "p_game_id": string }; Returns: {
              "config": NonNullable<Json>,
"created_at": string,
"ended_at": string | null,
"guesser": string | null,
"id": string,
"judgement": Json | null,
"kind": Database["public"]['Enums']["game_kind"],
"moves_in": number,
"paused_at": string | null,
"paused_phase_left": string | null,
"paused_turn_left": string | null,
"phase": Database["public"]['Enums']["game_phase"],
"phase_deadline": string | null,
"resolved": boolean,
"reveal": Json | null,
"revoted": boolean,
"room_id": string,
"round": number,
"settings": NonNullable<Json>,
"step": number,
"turn_deadline": string | null,
"turn_index": number | null,
"turn_order": (string)[],
"vote_candidates": (string)[] | null,
"winner": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "games"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_interests":
{ Args: { "p_interests": (string)[],"p_room_id": string }; Returns: {
              "adult_confirmed": boolean,
"id": string,
"interests": (string)[] | null,
"joined_at": string,
"left_at": string | null,
"nickname": string,
"removed_by_host": boolean,
"role": Database["public"]['Enums']["member_role"],
"room_id": string,
"topic": string | null,
"user_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "room_members"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_topic":
{ Args: { "p_room_id": string,"p_topic": string }; Returns: {
              "adult_confirmed": boolean,
"id": string,
"interests": (string)[] | null,
"joined_at": string,
"left_at": string | null,
"nickname": string,
"removed_by_host": boolean,
"role": Database["public"]['Enums']["member_role"],
"room_id": string,
"topic": string | null,
"user_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "room_members"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_voice":
{ Args: { "p_on": boolean,"p_room_id": string }; Returns: undefined
                           },
"settle_judgement":
{ Args: { "p_game_id": string,"p_overrule"?: boolean }; Returns: {
              "config": NonNullable<Json>,
"created_at": string,
"ended_at": string | null,
"guesser": string | null,
"id": string,
"judgement": Json | null,
"kind": Database["public"]['Enums']["game_kind"],
"moves_in": number,
"paused_at": string | null,
"paused_phase_left": string | null,
"paused_turn_left": string | null,
"phase": Database["public"]['Enums']["game_phase"],
"phase_deadline": string | null,
"resolved": boolean,
"reveal": Json | null,
"revoted": boolean,
"room_id": string,
"round": number,
"settings": NonNullable<Json>,
"step": number,
"turn_deadline": string | null,
"turn_index": number | null,
"turn_order": (string)[],
"vote_candidates": (string)[] | null,
"winner": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "games"
        isOneToOne: true
        isSetofReturn: false
      } },
"skip_phase":
{ Args: { "p_game_id": string }; Returns: {
              "config": NonNullable<Json>,
"created_at": string,
"ended_at": string | null,
"guesser": string | null,
"id": string,
"judgement": Json | null,
"kind": Database["public"]['Enums']["game_kind"],
"moves_in": number,
"paused_at": string | null,
"paused_phase_left": string | null,
"paused_turn_left": string | null,
"phase": Database["public"]['Enums']["game_phase"],
"phase_deadline": string | null,
"resolved": boolean,
"reveal": Json | null,
"revoted": boolean,
"room_id": string,
"round": number,
"settings": NonNullable<Json>,
"step": number,
"turn_deadline": string | null,
"turn_index": number | null,
"turn_order": (string)[],
"vote_candidates": (string)[] | null,
"winner": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "games"
        isOneToOne: true
        isSetofReturn: false
      } },
"skip_turn":
{ Args: { "p_game_id": string }; Returns: {
              "config": NonNullable<Json>,
"created_at": string,
"ended_at": string | null,
"guesser": string | null,
"id": string,
"judgement": Json | null,
"kind": Database["public"]['Enums']["game_kind"],
"moves_in": number,
"paused_at": string | null,
"paused_phase_left": string | null,
"paused_turn_left": string | null,
"phase": Database["public"]['Enums']["game_phase"],
"phase_deadline": string | null,
"resolved": boolean,
"reveal": Json | null,
"revoted": boolean,
"room_id": string,
"round": number,
"settings": NonNullable<Json>,
"step": number,
"turn_deadline": string | null,
"turn_index": number | null,
"turn_order": (string)[],
"vote_candidates": (string)[] | null,
"winner": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "games"
        isOneToOne: true
        isSetofReturn: false
      } },
"start_display_pairing":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"start_game":
{ Args: { "p_kind": Database["public"]['Enums']["game_kind"],"p_room_id": string,"p_settings"?: Json }; Returns: {
              "config": NonNullable<Json>,
"created_at": string,
"ended_at": string | null,
"guesser": string | null,
"id": string,
"judgement": Json | null,
"kind": Database["public"]['Enums']["game_kind"],
"moves_in": number,
"paused_at": string | null,
"paused_phase_left": string | null,
"paused_turn_left": string | null,
"phase": Database["public"]['Enums']["game_phase"],
"phase_deadline": string | null,
"resolved": boolean,
"reveal": Json | null,
"revoted": boolean,
"room_id": string,
"round": number,
"settings": NonNullable<Json>,
"step": number,
"turn_deadline": string | null,
"turn_index": number | null,
"turn_order": (string)[],
"vote_candidates": (string)[] | null,
"winner": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "games"
        isOneToOne: true
        isSetofReturn: false
      } },
"submit_action":
{ Args: { "p_action_id": string,"p_game_id": string,"p_kind": string,"p_payload": Json }; Returns: {
              "created_at": string,
"game_id": string,
"id": string,
"kind": string,
"member_id": string,
"payload": NonNullable<Json>,
"room_id": string,
"round": number,
"step": number
            }
                          SetofOptions: {
        from: "*"
        to: "game_actions"
        isOneToOne: true
        isSetofReturn: false
      } }
          }
          Enums: {
            "age_rating": "family"|"teen"|"adult","game_kind": "undercover"|"quiz"|"heads_up","game_phase": "setup"|"clues"|"discussion"|"vote"|"guess"|"ended"|"question"|"reveal"|"ready"|"guessing"|"recap","member_role": "host"|"player","room_status": "lobby"|"playing"|"closed"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "graphql_public": {
          Enums: {
            
          }
        },"public": {
          Enums: {
            "age_rating": ["family", "teen", "adult"],"game_kind": ["undercover", "quiz", "heads_up"],"game_phase": ["setup", "clues", "discussion", "vote", "guess", "ended", "question", "reveal", "ready", "guessing", "recap"],"member_role": ["host", "player"],"room_status": ["lobby", "playing", "closed"]
          }
        }
} as const

