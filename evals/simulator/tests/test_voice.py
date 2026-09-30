from gamenight_simulator.voice import clip_gaps


def change(table, **row):
    return {"payload": {"table": table, "record": row}}


def test_each_voiced_line_is_timed_from_the_line_to_its_clip_and_silent_ones_are_counted():
    broadcasts = [
        change("host_lines", id="a", created_at="2026-09-30T02:29:29.100000+00:00"),
        change("games", id="g", phase="clues"),
        change("clips", line_id="a", created_at="2026-09-30T02:29:29.500000+00:00"),
        change("host_lines", id="b", created_at="2026-09-30T02:29:31+00:00"),  # never voiced: stays a caption
    ]
    shown, gaps = clip_gaps(broadcasts)
    assert shown == 2 and [round(g, 2) for g in gaps] == [0.4]
