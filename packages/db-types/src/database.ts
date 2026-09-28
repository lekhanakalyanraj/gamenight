
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
                    "adult_confirmed": boolean,"id": string,"joined_at": string,"left_at": string | null,"nickname": string,"removed_by_host": boolean,"role": Database["public"]['Enums']["member_role"],"room_id": string,"user_id": string
                  }
                  Insert: {
                    "adult_confirmed"?: boolean,"id"?: string,"joined_at"?: string,"left_at"?: string | null,"nickname": string,"removed_by_host"?: boolean,"role"?: Database["public"]['Enums']["member_role"],"room_id": string,"user_id": string
                  }
                  Update: {
                    "adult_confirmed"?: boolean,"id"?: string,"joined_at"?: string,"left_at"?: string | null,"nickname"?: string,"removed_by_host"?: boolean,"role"?: Database["public"]['Enums']["member_role"],"room_id"?: string,"user_id"?: string
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
                    "age_rating": Database["public"]['Enums']["age_rating"],"closed_at": string | null,"code": string,"created_at": string,"host_id": string,"id": string,"max_players": number,"status": Database["public"]['Enums']["room_status"]
                  }
                  Insert: {
                    "age_rating"?: Database["public"]['Enums']["age_rating"],"closed_at"?: string | null,"code": string,"created_at"?: string,"host_id": string,"id"?: string,"max_players"?: number,"status"?: Database["public"]['Enums']["room_status"]
                  }
                  Update: {
                    "age_rating"?: Database["public"]['Enums']["age_rating"],"closed_at"?: string | null,"code"?: string,"created_at"?: string,"host_id"?: string,"id"?: string,"max_players"?: number,"status"?: Database["public"]['Enums']["room_status"]
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "create_room":
{ Args: { "p_age_rating"?: Database["public"]['Enums']["age_rating"],"p_confirm_adult"?: boolean,"p_nickname": string }; Returns: {
              "age_rating": Database["public"]['Enums']["age_rating"],
"closed_at": string | null,
"code": string,
"created_at": string,
"host_id": string,
"id": string,
"max_players": number,
"status": Database["public"]['Enums']["room_status"]
            }
                          SetofOptions: {
        from: "*"
        to: "rooms"
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
"joined_at": string,
"left_at": string | null,
"nickname": string,
"removed_by_host": boolean,
"role": Database["public"]['Enums']["member_role"],
"room_id": string,
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
"remove_display":
{ Args: { "p_display_id": string }; Returns: undefined
                           },
"start_display_pairing":
{ Args: Record<PropertyKey, never>; Returns: string
                           }
          }
          Enums: {
            "age_rating": "family"|"teen"|"adult","member_role": "host"|"player","room_status": "lobby"|"playing"|"closed"
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
            "age_rating": ["family", "teen", "adult"],"member_role": ["host", "player"],"room_status": ["lobby", "playing", "closed"]
          }
        }
} as const

