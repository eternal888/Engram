import anthropic
from backend.core.config import ANTHROPIC_API_KEY
from backend.core.pii_scrubber import scrub
from backend.core.tracing import new_trace_id, trace_agent
from backend.agents.extraction_agent import extract_memory
from backend.graph.memory_writer import write_memory
from backend.agents.retrieval_agent import retrieve_memories
from backend.agents.contradiction_agent import detect_contradictions
from backend.agents.grounding_agent import ground_response

client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)


def build_context(memories: list) -> str:
    if not memories:
        return "No relevant memories found."

    context = "Relevant memories from past conversations:\n\n"
    for i, mem in enumerate(memories, 1):
        context += f"{i}. [{mem['type']}] {mem['text']} (similarity: {mem['similarity']}, confidence: {mem['confidence']})\n"
    return context


def process_memory_background(safe_message: str, user_id: str, trace_id: str):
    """
    Runs AFTER the response is already sent to the user.
    Extraction → contradiction detection → memory write.

    The user never waits for this. If it fails, their chat still worked —
    we log the error rather than surfacing it.
    """
    try:
        with trace_agent(trace_id, user_id, "extraction", input_summary=safe_message[:200]) as event:
            extraction = extract_memory(safe_message, user_id=user_id)
            facts = extraction["extracted"]["facts"]
            event["output_summary"] = f"{len(facts)} facts extracted"

        with trace_agent(trace_id, user_id, "contradiction") as event:
            contradictions = detect_contradictions(facts, user_id=user_id)
            event["output_summary"] = f"{len(contradictions)} contradictions found"

        with trace_agent(trace_id, user_id, "memory_writer") as event:
            write_memory(extraction)
            event["output_summary"] = f"episode={extraction['episode_id']}"

        print(f"✅ Background memory processing complete — trace {trace_id[:8]}")
    except Exception as e:
        print(f"❌ Background memory processing failed — trace {trace_id[:8]}: {e}")


def chat(message: str, user_id: str = "default") -> dict:
    """
    Fast path only. Returns as soon as answer + grounding are ready.
    Memory writing is handed to the route to schedule in the background.
    """
    trace_id = new_trace_id()

    # ── Step 0: PII scrub ──
    with trace_agent(trace_id, user_id, "pii_scrubber", input_summary=message[:200]) as event:
        scrub_result = scrub(message)
        safe_message = scrub_result["scrubbed_text"]
        event["output_summary"] = f"pii_found={scrub_result['had_pii']}"

    if scrub_result["had_pii"]:
        detected = ", ".join(sorted({p["type"] for p in scrub_result["pii_found"]}))
        print(f"🔒 PII scrubbed from input: {detected}")

    # ── Step 1: Retrieve relevant memories ──
    with trace_agent(trace_id, user_id, "retrieval", input_summary=safe_message[:200]) as event:
        memories = retrieve_memories(safe_message, user_id=user_id, top_k=3)
        event["output_summary"] = f"{len(memories)} memories retrieved"

    context = build_context(memories)

    # ── Step 2: Generate response with Claude ──
    with trace_agent(trace_id, user_id, "response_generation", input_summary=safe_message[:200]) as event:
        response = client.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=1000,
            system="""You are a helpful assistant with memory.
You have access to memories from past conversations.
Always use the provided memories to give personalized, contextual responses.
If memories are relevant, reference them naturally in your response.
When you see placeholders like [PERSON], [EMAIL_ADDRESS], [PHONE_NUMBER], [LOCATION], etc.,
these represent redacted personal information — respond naturally around them but do not fabricate values.""",
            messages=[
                {"role": "user", "content": f"{context}\n\nCurrent message: {safe_message}"}
            ]
        )
        answer = response.content[0].text
        event["tokens_input"] = response.usage.input_tokens
        event["tokens_output"] = response.usage.output_tokens
        event["output_summary"] = answer[:200]

    # ── Step 3: Ground the response (stays in fast path — core feature) ──
    with trace_agent(trace_id, user_id, "grounding") as event:
        grounding = ground_response(answer, memories)
        event["output_summary"] = f"score={grounding.get('grounding_score')}"

    # Steps 4-6 (extraction, contradiction, memory write) now run in the
    # background via process_memory_background(), scheduled by the route.
    return {
        "response": answer,
        "memories_used": memories,
        "grounding": grounding,
        "pii_scrubbed": scrub_result["had_pii"],
        "pii_types": sorted({p["type"] for p in scrub_result["pii_found"]}),
        "trace_id": trace_id,
        "episode_id": None,                  # written asynchronously
        "contradictions": [],                # detected asynchronously
        "memory_processing": "background",
        "_safe_message": safe_message,       # consumed by the route, stripped before send
    }