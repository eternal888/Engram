from fastapi import APIRouter
from pydantic import BaseModel
from backend.agents.orchestrator import chat
from backend.graph.graph_client import graph_client

router = APIRouter()


class ChatRequest(BaseModel):
    message: str
    user_id: str = "default"


@router.post("/chat")
def chat_endpoint(request: ChatRequest):
    result = chat(request.message, user_id=request.user_id)
    return result


@router.get("/memory/graph")
def get_graph(user_id: str = "default"):
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
def get_episodes(user_id: str = "default"):
    episodes = graph_client.run("""
        MATCH (e:Episode)
        WHERE e.user_id = $user_id
        RETURN e.id as id, e.summary as summary,
               e.created_at as created_at, e.confidence as confidence
        ORDER BY e.created_at DESC
        """, {"user_id": user_id})
    return {"episodes": episodes}

@router.get("/memory/health")
def get_health(user_id: str = "default"):
    from backend.agents.curator_agent import graph_health_report
    return graph_health_report(user_id)
class FeedbackRequest(BaseModel):
    node_id: str
    feedback: str  # "correct", "incorrect", or "edit"
    corrected_value: str = ""


@router.post("/memory/feedback")
def feedback_endpoint(request: FeedbackRequest):
    from datetime import datetime
    now = datetime.utcnow().isoformat()
    
    if request.feedback == "correct":
        graph_client.run("""
            MATCH (n {id: $id})
            SET n.confidence = CASE 
                    WHEN n.confidence + 0.1 > 1.0 THEN 1.0 
                    ELSE n.confidence + 0.1 
                END,
                n.confirmation_count = coalesce(n.confirmation_count, 0) + 1,
                n.last_accessed = $now
            RETURN n.id as id, n.confidence as confidence
            """, {"id": request.node_id, "now": now})
        return {"status": "confirmed", "node_id": request.node_id}

    elif request.feedback == "incorrect":
        from backend.graph.versioning import version_node
        version_node(request.node_id, change_reason="user marked incorrect")
        
        graph_client.run("""
            MATCH (n {id: $id})
            SET n.confidence = n.confidence * 0.5,
                n.status = 'disputed'
            RETURN n.id as id, n.confidence as confidence
            """, {"id": request.node_id})
        return {"status": "disputed", "node_id": request.node_id}

    elif request.feedback == "edit" and request.corrected_value:
        from backend.graph.versioning import version_node
        from backend.core.embeddings import embed_text
        
        version_node(request.node_id, change_reason=f"user edit: {request.corrected_value[:50]}")
        new_embedding = embed_text(request.corrected_value)
        
        graph_client.run("""
            MATCH (n {id: $id})
            SET n.content = $content,
                n.embedding = $embedding,
                n.confidence = 1.0,
                n.status = 'edited'
            RETURN n.id as id
            """, {
            "id": request.node_id,
            "content": request.corrected_value,
            "embedding": new_embedding
        })
        return {"status": "edited", "node_id": request.node_id}

    return {"status": "invalid_feedback"}