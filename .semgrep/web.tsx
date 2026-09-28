// Test cases for web.yml. Run with `make semgrep-test`.

export function Caption({ text }: { text: string }) {
  // ok: gamenight.no-dangerously-set-inner-html
  return <p className="caption">{text}</p>;
}

export function UnsafeCaption({ html }: { html: string }) {
  // ruleid: gamenight.no-dangerously-set-inner-html
  return <p className="caption" dangerouslySetInnerHTML={{ __html: html }} />;
}

export async function writes(supabase: any, roomId: string) {
  // ok: gamenight.writes-go-through-rpc
  await supabase.rpc("leave_room", { p_room_id: roomId });
  // ok: gamenight.writes-go-through-rpc
  await supabase.from("rooms").select("*").eq("id", roomId);
  // ruleid: gamenight.writes-go-through-rpc
  await supabase.from("rooms").update({ status: "closed" }).eq("id", roomId);
  // ruleid: gamenight.writes-go-through-rpc
  await supabase.from("room_members").insert({ room_id: roomId });
}
