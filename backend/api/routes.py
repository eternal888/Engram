from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from datetime import datetime
from backend.agents.orchestrator import chat
from backend.graph.graph_client import graph_client

router = APIRouter()


# ────────────────────────────────────────────────────────────────
# Request models — user_id is REQUIRED. No silent defaults.
# ────────────────────────────────────────────────────────────────
class ChatRequest(BaseModel):
    message: str
    user_id: str = Field(..., min_length=1, description="Required — identifies the user's memory graph")


class FeedbackRequest(BaseModel):
    node_id: str
    user_id: str = Field(..., min_length=1)
    feedback: str  # "correct", "incorrect", or "edit"
    corrected_value: str = ""


# ────────────────────────────────────────────────────────────────
# Ownership check — every mutation verifies the node belongs to
# the caller. Prevents cross-user data manipulation.
# ────────────────────────────────────────────────────────────────
def _assert_owns(node_id: str, user_id: str):
    result = graph_client.run(
        "MATCH (n {id: $id}) RETURN n.user_id as owner",
        {"id": node_id}
    )
    if not result:
        raise HTTPException(status_code=404, detail="Node not found")
    if result[0]["owner"] != user_id:
        # Deliberately vague — don't leak whether node exists for another user
        raise HTTPException(status_code=404, detail="Node not found")


# ────────────────────────────────────────────────────────────────
# Endpoints
# ────────────────────────────────────────────────────────────────
@router.post("/chat")
def chat_endpoint(request: ChatRequest):
    return chat(request.message, user_id=request.user_id)


@router.get("/memory/graph")
def get_graph(user_id: str):
    nodes = graph_client.run("""
        MATCH (n)
        WHERE n.user_id = $user_id
        RETURN labels(n)[0] as type, n.id as id,
               coalesce(n.summary, n.content, n.name, '') as label,
               n.confidence as confidence,
               n.ttl_tier as tier
        """, {"user_id": user_id})

    edges = graph_client.run("""
        MATCH (a)-[r]->(b)
        WHERE a.user_id = $user_id AND b.user_id = $user_id
        RETURN a.id as source, b.id as target, type(r) as relationship
        """, {"user_id": user_id})

    return {"nodes": nodes, "edges": edges}


@router.get("/memory/episodes")
def get_episodes(user_id: str):
    episodes = graph_client.run("""
        MATCH (e:Episode)
        WHERE e.user_id = $user_id
        RETURN e.id as id, e.summary as summary,
               e.created_at as created_at, e.confidence as confidence
        ORDER BY e.created_at DESC
        """, {"user_id": user_id})
    return {"episodes": episodes}


@router.get("/memory/health")
def get_health(user_id: str):
    from backend.agents.curator_agent import graph_health_report
    return graph_health_report(user_id)


@router.post("/memory/feedback")
def feedback_endpoint(request: FeedbackRequest):
    _assert_owns(request.node_id, request.user_id)
    now = datetime.utcnow().isoformat()

    if request.feedback == "correct":
        graph_client.run("""
            MATCH (n {id: $id, user_id: $user_id})
            SET n.confidence = CASE
                    WHEN n.confidence + 0.1 > 1.0 THEN 1.0
                    ELSE n.confidence + 0.1
                END,
                n.confirmation_count = coalesce(n.confirmation_count, 0) + 1,
                n.last_accessed = $now
            RETURN n.id as id, n.confidence as confidence
            """, {"id": request.node_id, "user_id": request.user_id, "now": now})
        return {"status": "confirmed", "node_id": request.node_id}

    elif request.feedback == "incorrect":
        from backend.graph.versioning import version_node
        version_node(request.node_id, change_reason="user marked incorrect")

        graph_client.run("""
            MATCH (n {id: $id, user_id: $user_id})
            SET n.confidence = n.confidence * 0.5,
                n.status = 'disputed'
            RETURN n.id as id, n.confidence as confidence
            """, {"id": request.node_id, "user_id": request.user_id})
        return {"status": "disputed", "node_id": request.node_id}

    elif request.feedback == "edit" and request.corrected_value:
        from backend.graph.versioning import version_node
        from backend.core.embeddings import embed_text

        version_node(
            request.node_id,
            change_reason=f"user edit: {request.corrected_value[:50]}"
        )
        new_embedding = embed_text(request.corrected_value)

        graph_client.run("""
            MATCH (n {id: $id, user_id: $user_id})
            SET n.content = $content,
                n.embedding = $embedding,
                n.confidence = 1.0,
                n.status = 'edited'
            RETURN n.id as id
            """, {
            "id": request.node_id,
            "user_id": request.user_id,
            "content": request.corrected_value,
            "embedding": new_embedding
        })
        return {"status": "edited", "node_id": request.node_id}

    raise HTTPException(status_code=400, detail="Invalid feedback type")