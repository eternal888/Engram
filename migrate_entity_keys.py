"""One-off migration. Run once, after deploying the new memory_writer."""
import sys
from backend.graph.graph_client import graph_client
from backend.graph.memory_writer import entity_key


def collect():
    rows = graph_client.run("""
        MATCH (en:Entity)
        RETURN en.id AS id, en.name AS name, en.user_id AS user_id,
               en.created_at AS created_at,
               size([(en)--() | 1]) AS degree
        """)
    groups = {}
    for r in rows:
        k = (r["user_id"], entity_key(r["name"]))
        groups.setdefault(k, []).append(r)
    return groups


def main(apply: bool):
    groups = collect()
    dupes = {k: v for k, v in groups.items() if len(v) > 1}

    total = sum(len(v) for v in groups.values())
    print(f"{total} entity nodes -> {len(groups)} after merge ({total - len(groups)} collapsed)")

    for (user_id, key), members in sorted(dupes.items(), key=lambda kv: -len(kv[1])):
        names = ", ".join(sorted({m["name"] for m in members}))
        print(f"  {key:<28} x{len(members):<3} [{names}]")

    if not apply:
        print("\nDry run. Re-run with --apply to write.")
        return

    for (user_id, key), members in groups.items():
        for m in members:
            graph_client.run(
                "MATCH (en:Entity {id: $id}) SET en.key = $key",
                {"id": m["id"], "key": key}
            )

    for (user_id, key), members in dupes.items():
        members.sort(key=lambda m: (-m["degree"], m["created_at"] or ""))
        survivor, rest = members[0], members[1:]

        for loser in rest:
            graph_client.run("""
                MATCH (keep:Entity {id: $keep_id})
                MATCH (drop:Entity {id: $drop_id})
                CALL {
                    WITH keep, drop
                    MATCH (other)-[r]->(drop)
                    WHERE other <> keep
                    CALL apoc.merge.relationship(other, type(r), {}, properties(r), keep)
                    YIELD rel RETURN count(rel) AS a
                }
                CALL {
                    WITH keep, drop
                    MATCH (drop)-[r]->(other)
                    WHERE other <> keep
                    CALL apoc.merge.relationship(keep, type(r), {}, properties(r), other)
                    YIELD rel RETURN count(rel) AS b
                }
                DETACH DELETE drop
                """, {"keep_id": survivor["id"], "drop_id": loser["id"]})

        graph_client.run("""
            MATCH (en:Entity {id: $id})
            SET en.mention_count = coalesce(en.mention_count, 0) + $extra
            """, {"id": survivor["id"], "extra": len(rest)})

    graph_client.run(
        "CREATE INDEX entity_key IF NOT EXISTS FOR (en:Entity) ON (en.key, en.user_id)"
    )
    print("\nDone. Index created on (key, user_id).")


if __name__ == "__main__":
    main("--apply" in sys.argv)