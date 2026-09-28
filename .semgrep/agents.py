# Test cases for agents.yml. Run with `make semgrep-test`.


async def resolve_vote(conn, game_id, event_id, clue):
    # ok: gamenight.no-sql-string-building
    await conn.execute("select public.gm_resolve_vote(%s, %s)", (game_id, event_id))
    # ok: gamenight.no-sql-string-building
    await conn.fetchrow("select * from public.gm_open_phase($1, $2)", game_id, event_id)
    # ruleid: gamenight.no-sql-string-building
    await conn.execute(f"select public.gm_judge('{clue}')")
    # ruleid: gamenight.no-sql-string-building
    await conn.execute("select public.gm_judge('%s')" % clue)
    # ruleid: gamenight.no-sql-string-building
    await conn.fetchval("select public.gm_judge('{}')".format(clue))
    # ruleid: gamenight.no-sql-string-building
    await conn.execute("select public.gm_judge('" + clue + "')")
