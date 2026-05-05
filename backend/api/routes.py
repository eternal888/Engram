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