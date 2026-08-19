
import json
import uuid
from datetime import datetime, timezone
from backend.core.llm_client import client, MODEL_EXTRACTION

EXTRACTION_PROMPT = """You are a memory extraction agent. Given a conversation turn, extract structured memory.

Return ONLY valid JSON with this exact structure:
{
    "entities": [
        {"name": "entity name", "type": "person/place/organization/thing", "description": "brief description"}
    ],
    "facts": [
        {"content": "a fact that was stated", "confidence": 0.9}
    ],
    "relationships": [
        {"from": "entity name", "to": "entity name", "type": "relationship type"}
    ],
    "episode_summary": "one sentence summary of this conversation turn"
}

Rules:
- Only extract what is explicitly stated
- Extract facts about the user and the world, never facts about the
  conversation itself. "User asked about X" is not a memory — it records
  that a question was asked, not anything true of the user. If a turn is
  purely a question and states nothing, return an empty facts list.
- Confidence score 0.0 to 1.0
- Return valid JSON only, no other text"""


def _extract_json(raw: str) -> dict:
    """
    Take the outermost JSON object. Tolerates code fences and any prose the
    model puts around them, which the previous split("```") approach did not.
    """
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise ValueError(f"no JSON object in response: {raw[:200]}")
    return json.loads(raw[start:end + 1])


def extract_memory(text: str, user_id: str = "default") -> dict:
    response = client.messages.create(
        model=MODEL_EXTRACTION,
        max_tokens=1000,
        messages=[
            {
                "role": "user",
                "content": f"{EXTRACTION_PROMPT}\n\nConversation turn:\n{text}"
            }
        ]
    )

    raw = response.content[0].text.strip()
    print("Raw response:", raw)

    extracted = _extract_json(raw)

    return {
        "episode_id": str(uuid.uuid4()),
        "user_id": user_id,
        "raw_text": text,
        "extracted": extracted,
        "created_at": datetime.now(timezone.utc).isoformat(),
        # Surfaced so the caller's trace_agent context can record cost.
        # Without this the TraceEvent shows zero tokens for extraction, which
        # makes the eval harness understate spend by several times over.
        "usage": {
            "tokens_input": response.usage.input_tokens,
            "tokens_output": response.usage.output_tokens,
        },
    }