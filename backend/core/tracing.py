"""
Lightweight agent observability.

Every chat turn gets a trace_id. Every agent call logs a TraceEvent node
in Neo4j with latency, tokens, and status. Later queryable via /api/traces.

Usage:
    from backend.core.tracing import trace_agent, new_trace_id

    trace_id = new_trace_id()
    with trace_agent(trace_id, user_id, "extraction") as event:
        result = extraction_agent.run(text)
        event["tokens_input"] = result.get("tokens_in", 0)
        event["tokens_output"] = result.get("tokens_out", 0)

If the block raises, status is set to 'error' and the exception re-raised
(so real chat behavior is unaffected by observability).
"""

import uuid
import time
from datetime import datetime
from contextlib import contextmanager
from backend.graph.graph_client import graph_client



def new_trace_id() -> str:
    return str(uuid.uuid4())


@contextmanager
def trace_agent(trace_id: str, user_id: str, agent_name: str, input_summary: str = ""):
    """
    Context manager that times an agent call and writes a TraceEvent on exit.
    Yields a mutable dict — agents update tokens_input/tokens_output/output_summary on it.
    """
    event = {
        "tokens_input": 0,
        "tokens_output": 0,
        "output_summary": "",
    }
    start = time.perf_counter()
    status = "success"
    error_message = ""

    try:
        yield event
    except Exception as e:
        status = "error"
        error_message = str(e)[:500]
        raise
    finally:
        latency_ms = int((time.perf_counter() - start) * 1000)
        now = datetime.utcnow().isoformat()
        event_id = str(uuid.uuid4())

        try:
            graph_client.run("""
                CREATE (t:TraceEvent {
                    id: $id,
                    trace_id: $trace_id,
                    user_id: $user_id,
                    agent_name: $agent_name,
                    latency_ms: $latency_ms,
                    tokens_input: $tokens_input,
                    tokens_output: $tokens_output,
                    status: $status,
                    error_message: $error_message,
                    input_summary: $input_summary,
                    output_summary: $output_summary,
                    created_at: $now
                })
                """, {
                "id": event_id,
                "trace_id": trace_id,
                "user_id": user_id,
                "agent_name": agent_name,
                "latency_ms": latency_ms,
                "tokens_input": event["tokens_input"],
                "tokens_output": event["tokens_output"],
                "status": status,
                "error_message": error_message,
                "input_summary": (input_summary or "")[:200],
                "output_summary": (event["output_summary"] or "")[:200],
                "now": now,
            })
        except Exception as write_err:
            # Never let observability failure break the actual request
            print(f"⚠️ Trace write failed for {agent_name}: {write_err}")