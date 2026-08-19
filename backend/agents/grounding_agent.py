
import json
from backend.core.llm_client import client

NO_USAGE = {"tokens_input": 0, "tokens_output": 0}


def _extract_json(raw: str) -> dict:
    """
    Take the outermost JSON object. Tolerates code fences and surrounding prose,
    which the previous split("```") approach did not — a stray word before the
    fence would raise and take the whole grounding step down with it.
    """
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise ValueError(f"no JSON object in response: {raw[:200]}")
    return json.loads(raw[start:end + 1])


def ground_response(response_text: str, memories: list) -> dict:
    if not memories:
        return {
            "grounded_response": response_text,
            "citations": [],
            "grounding_score": 0.0,
            "ungrounded_claims": [],
            "is_grounded": False,
            # No model call made, but the caller records usage unconditionally.
            "usage": dict(NO_USAGE),
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

    usage = {
        "tokens_input": result.usage.input_tokens,
        "tokens_output": result.usage.output_tokens,
    }

    parsed = _extract_json(result.content[0].text.strip())

    citations = []
    ungrounded = []

    for claim in parsed.get("claims", []):
        # Every field accessed with .get(): a missing key in one claim object
        # should not fail the whole verification pass.
        text = claim.get("claim", "")
        if not text:
            continue

        idx = claim.get("memory_index")
        if claim.get("is_grounded") and idx is not None:
            i = int(idx) - 1
            if 0 <= i < len(memories):
                citations.append({
                    "claim": text,
                    "memory": memories[i],
                    "trust_score": claim.get("trust_score", 0.0),
                })
            else:
                # Claimed grounded but cited a memory that does not exist.
                ungrounded.append(text)
        else:
            ungrounded.append(text)

    return {
        "grounded_response": response_text,
        "citations": citations,
        "grounding_score": parsed.get("grounding_score", 0.0),
        "ungrounded_claims": ungrounded,
        "is_grounded": parsed.get("is_grounded", False),
        "usage": usage,
    }