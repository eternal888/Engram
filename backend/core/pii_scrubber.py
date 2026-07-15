"""
PII Scrubber — detects and redacts sensitive info before it hits Neo4j.
Uses Microsoft Presidio + spaCy for detection.

Design principle: PII never touches the database. Scrubbing happens at the
ingress point (Orchestrator → Extraction), so all downstream storage,
embeddings, and logs are already sanitized.
"""

from presidio_analyzer import AnalyzerEngine
from presidio_anonymizer import AnonymizerEngine
from presidio_anonymizer.entities import OperatorConfig

# What we scrub. Extendable.
DEFAULT_ENTITIES = [
    "EMAIL_ADDRESS",
    "PHONE_NUMBER",
    "CREDIT_CARD",
    "US_SSN",
    "IP_ADDRESS",
    "IBAN_CODE",
    "US_BANK_NUMBER",
    "US_PASSPORT",
    "US_DRIVER_LICENSE",
    "PERSON",
    "LOCATION",
]

# One-time init — spaCy load is expensive
_analyzer = AnalyzerEngine()
_anonymizer = AnonymizerEngine()


def scrub(text: str, entities: list = None) -> dict:
    """
    Detect and redact PII in text.

    Returns:
        {
            "scrubbed_text": "...",   # safe to store
            "pii_found": [            # audit record
                {"type": "EMAIL_ADDRESS", "start": 12, "end": 27, "score": 0.95}
            ],
            "had_pii": bool
        }
    """
    if not text or not text.strip():
        return {"scrubbed_text": text, "pii_found": [], "had_pii": False}

    entities = entities or DEFAULT_ENTITIES

    # 1. Detect
    results = _analyzer.analyze(text=text, entities=entities, language="en")

    if not results:
        return {"scrubbed_text": text, "pii_found": [], "had_pii": False}

    # 2. Redact — replace each entity with its type label
    operators = {
        e: OperatorConfig("replace", {"new_value": f"[{e}]"}) for e in entities
    }

    scrubbed = _anonymizer.anonymize(
        text=text, analyzer_results=results, operators=operators
    )

    pii_audit = [
        {
            "type": r.entity_type,
            "start": r.start,
            "end": r.end,
            "score": round(r.score, 3),
        }
        for r in results
    ]

    return {
        "scrubbed_text": scrubbed.text,
        "pii_found": pii_audit,
        "had_pii": True,
    }