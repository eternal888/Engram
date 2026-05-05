import uuid
from datetime import datetime
from backend.graph.graph_client import graph_client


def version_node(node_id: str, change_reason: str = "update") -> str:
    """
    Before updating a node, snapshot its current state as a version.
    Returns the version_id of the snapshot.
    """
    version_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()

    # Get current state of the node
    result = graph_client.run("""
        MATCH (n {id: $node_id})
        RETURN n, labels(n)[0] as type
        """, {"node_id": node_id})

    if not result:
        return None

    node_data = result[0]["n"]
    node_type = result[0]["type"]

    # Create version snapshot node
    graph_client.run("""
        CREATE (v:Version {
            id: $version_id,
            original_node_id: $node_id,
            original_type: $node_type,
            snapshot: $snapshot,
            change_reason: $change_reason,
            versioned_at: $now
        })
        WITH v
        MATCH (n {id: $node_id})
        MERGE (n)-[:EVOLVED_FROM]->(v)
        """, {
        "version_id": version_id,
        "node_id": node_id,
        "node_type": node_type,
        "snapshot": str(dict(node_data)),
        "change_reason": change_reason,
        "now": now
    })

    return version_id


def get_node_history(node_id: str) -> list:
    """
    Get all historical versions of a node.
    """
    result = graph_client.run("""
        MATCH (n {id: $node_id})-[:EVOLVED_FROM]->(v:Version)
        RETURN v.id as version_id, 
               v.snapshot as snapshot,
               v.change_reason as change_reason,
               v.versioned_at as versioned_at
        ORDER BY v.versioned_at DESC
        """, {"node_id": node_id})

    return result