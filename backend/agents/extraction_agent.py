import anthropic
import json
import uuid
from datetime import datetime
from backend.core.config import ANTHROPIC_API_KEY

client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

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
- Confidence score 0.0 to 1.0
- Return valid JSON only, no other text"""


def extract_memory(text: str, user_id: str = "default") -> dict:
    response = client.messages.create(
        model="claude-sonnet-4-5",
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

    # strip markdown code blocks if present
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]

    extracted = json.loads(raw)

    return {
        "episode_id": str(uuid.uuid4()),
        "user_id": user_id,
        "raw_text": text,
        "extracted": extracted,
        "created_at": datetime.utcnow().isoformat()
    }