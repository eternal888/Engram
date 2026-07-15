import anthropic
from backend.core.config import ANTHROPIC_API_KEY
from backend.core.pii_scrubber import scrub
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


def chat(message: str, user_id: str = "default") -> dict:
    # Step 0 — Scrub PII BEFORE anything touches the database.
    # This is the gatekeeper: everything downstream sees the scrubbed version.
    scrub_result = scrub(message)
    safe_message = scrub_result["scrubbed_text"]

    if scrub_result["had_pii"]:
        detected = ", ".join(sorted({p["type"] for p in scrub_result["pii_found"]}))
        print(f"🔒 PII scrubbed from input: {detected}")

    # Step 1 — Retrieve relevant memories (using scrubbed query)
    memories = retrieve_memories(safe_message, user_id=user_id, top_k=3)
    context = build_context(memories)

    # Step 2 — Generate response using memories as context
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
            {
                "role": "user",
                "content": f"{context}\n\nCurrent message: {safe_message}"
            }
        ]
    )

    answer = response.content[0].text

    # Step 3 — Ground the response against memories
    grounding = ground_response(answer, memories)

    # Step 4 — Extract new memory (from the scrubbed message)
    extraction = extract_memory(safe_message, user_id=user_id)

    # Step 5 — Check for contradictions
    contradictions = detect_contradictions(
        extraction["extracted"]["facts"],
        user_id=user_id
    )

    # Step 6 — Write memory (already sanitized — no PII will hit Neo4j)
    write_memory(extraction)

    return {
        "response": answer,
        "memories_used": memories,
        "episode_id": extraction["episode_id"],
        "contradictions": contradictions,
        "grounding": grounding,
        "pii_scrubbed": scrub_result["had_pii"],
        "pii_types": sorted({p["type"] for p in scrub_result["pii_found"]}),
    }