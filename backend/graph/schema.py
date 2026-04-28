SCHEMA_QUERIES = [

    # ── Constraints (uniqueness) ──────────────────────────
    "CREATE CONSTRAINT episode_id IF NOT EXISTS FOR (e:Episode) REQUIRE e.id IS UNIQUE",
    "CREATE CONSTRAINT concept_id IF NOT EXISTS FOR (c:Concept) REQUIRE c.id IS UNIQUE",
    "CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (en:Entity) REQUIRE en.id IS UNIQUE",
    "CREATE CONSTRAINT source_id IF NOT EXISTS FOR (s:Source) REQUIRE s.id IS UNIQUE",
    "CREATE CONSTRAINT contradiction_id IF NOT EXISTS FOR (c:Contradiction) REQUIRE c.id IS UNIQUE",

    # ── Indexes (fast lookup) ─────────────────────────────
    "CREATE INDEX episode_user IF NOT EXISTS FOR (e:Episode) ON (e.user_id)",
    "CREATE INDEX concept_user IF NOT EXISTS FOR (c:Concept) ON (c.user_id)",
    "CREATE INDEX entity_user IF NOT EXISTS FOR (en:Entity) ON (en.user_id)",
    "CREATE INDEX episode_created IF NOT EXISTS FOR (e:Episode) ON (e.created_at)",
    "CREATE INDEX concept_name IF NOT EXISTS FOR (c:Concept) ON (c.name)",
    "CREATE INDEX entity_name IF NOT EXISTS FOR (en:Entity) ON (en.name)",
    "CREATE INDEX node_ttl IF NOT EXISTS FOR (e:Episode) ON (e.ttl_tier)",
]