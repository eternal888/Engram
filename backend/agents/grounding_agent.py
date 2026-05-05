import anthropic
import json
from backend.core.config import ANTHROPIC_API_KEY

client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)


def ground_response(response_text: str, memories: list) -> dict:
    if not memories:
        return {
            "grounded_response": response_text,
            "citations": [],
            "grounding_score": 0.0,
            "ungrounded_claims": [],
            "is_grounded": False
        }

    memory_text = "\n".join([
        f"[{i+1}] [{m['type']}] {m['text']} (confidence: {m['confidence']})"
        for i, m in enumerate(memories)
    ])

    prompt = f"""You are a grounding agent. Verify which claims in the response are supported by the provided memories.

Memories available:
{memory_text}

Response to verify:
{response_text}

Return ONLY valid JSON:
{{
    "claims": [
        {{
            "claim": "the specific claim from the response",
            "is_grounded": true/false,
            "memory_index": 1 (which memory supports it, or null if ungrounded),
            "trust_score": 0.0 to 1.0
        }}
    ],
    "grounding_score": 0.0 to 1.0,
    "is_grounded": true/false
}}

Rules:
- Only mark grounded if the memory directly supports the claim
- General knowledge claims (not user-specific) should be marked is_grounded=false
- grounding_score = grounded_claims / total_claims"""

    result = client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=1500,
        messages=[{"role": "user", "content": prompt}]
    )

    raw = result.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]

    parsed = json.loads(raw)

    citations = []
    ungrounded = []

    for claim in parsed.get("claims", []):
        if claim["is_grounded"] and claim.get("memory_index"):
            idx = claim["memory_index"] - 1
            if 0 <= idx < len(memories):
                citations.append({
                    "claim": claim["claim"],
                    "memory": memories[idx],
                    "trust_score": claim["trust_score"]
                })
        else:
            ungrounded.append(claim["claim"])

    return {
        "grounded_response": response_text,
        "citations": citations,
        "grounding_score": parsed.get("grounding_score", 0.0),
        "ungrounded_claims": ungrounded,
        "is_grounded": parsed.get("is_grounded", False)
    }