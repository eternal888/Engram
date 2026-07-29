"""
Trace query endpoints. All require JWT — users only see their own traces.

- GET /api/traces          → recent traces, grouped by trace_id
- GET /api/traces/{id}     → all agent events for one trace
- GET /api/traces/stats    → per-agent averages (latency, tokens, error rate)
"""

from fastapi import APIRouter, Depends, HTTPException
from backend.core.auth import get_current_user
from backend.graph.graph_client import graph_client

router = APIRouter(prefix="/traces", tags=["traces"])


@router.get("")
def list_traces(user_id: str = Depends(get_current_user), limit: int = 20):
    """Recent chat turns, one row each, with totals across all agents."""
    result = graph_client.run("""
        MATCH (t:TraceEvent)
        WHERE t.user_id = $user_id
        WITH t.trace_id as trace_id,
             min(t.created_at) as started_at,
             sum(t.latency_ms) as total_latency_ms,
             sum(t.tokens_input) as total_tokens_input,
             sum(t.tokens_output) as total_tokens_output,
             count(t) as agent_count,
             sum(CASE WHEN t.status = 'error' THEN 1 ELSE 0 END) as error_count
        RETURN trace_id, started_at, total_latency_ms,
               total_tokens_input, total_tokens_output,
               agent_count, error_count
        ORDER BY started_at DESC
        LIMIT $limit
        """, {"user_id": user_id, "limit": limit})
    return {"traces": result}


@router.get("/stats")
def trace_stats(user_id: str = Depends(get_current_user)):
    """Per-agent performance summary."""
    result = graph_client.run("""
        MATCH (t:TraceEvent)
        WHERE t.user_id = $user_id
        RETURN t.agent_name as agent_name,
               count(t) as calls,
               avg(t.latency_ms) as avg_latency_ms,
               max(t.latency_ms) as max_latency_ms,
               sum(t.tokens_input) as total_tokens_input,
               sum(t.tokens_output) as total_tokens_output,
               sum(CASE WHEN t.status = 'error' THEN 1 ELSE 0 END) as errors
        ORDER BY avg_latency_ms DESC
        """, {"user_id": user_id})

    for row in result:
        row["avg_latency_ms"] = round(row["avg_latency_ms"] or 0, 1)

    return {"agents": result}


@router.get("/{trace_id}")
def get_trace(trace_id: str, user_id: str = Depends(get_current_user)):
    """Full agent-by-agent breakdown of one chat turn."""
    result = graph_client.run("""
        MATCH (t:TraceEvent {trace_id: $trace_id, user_id: $user_id})
        RETURN t.agent_name as agent_name,
               t.latency_ms as latency_ms,
               t.tokens_input as tokens_input,
               t.tokens_output as tokens_output,
               t.status as status,
               t.error_message as error_message,
               t.input_summary as input_summary,
               t.output_summary as output_summary,
               t.created_at as created_at
        ORDER BY t.created_at ASC
        """, {"trace_id": trace_id, "user_id": user_id})

    if not result:
        raise HTTPException(status_code=404, detail="Trace not found")

    return {
        "trace_id": trace_id,
        "events": result,
        "total_latency_ms": sum(e["latency_ms"] or 0 for e in result),
        "total_tokens": sum((e["tokens_input"] or 0) + (e["tokens_output"] or 0) for e in result),
    }