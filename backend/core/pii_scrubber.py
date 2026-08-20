"""
PII Scrubber — detects and redacts sensitive info before it hits Neo4j.
Uses Microsoft Presidio + spaCy for detection.

Two entity sets, because the read and write paths have different needs:

  DEFAULT_ENTITIES — used on the WRITE path (memory extraction, document
      ingestion). Includes PERSON and LOCATION, so no names or places are
      ever persisted.

  QUERY_ENTITIES — used on the READ path (incoming chat messages). Excludes
      PERSON and LOCATION, because those are search terms in a question, not
      data being stored. Redacting them turns "what did I say about Hyderabad"
      into "what did I say about [LOCATION]", which matches nothing.

Genuinely sensitive identifiers — emails, phones, cards, SSNs — are scrubbed
on both paths.
"""

from presidio_analyzer import AnalyzerEngine
from presidio_analyzer.nlp_engine import NlpEngineProvider
from presidio_anonymizer import AnonymizerEngine
from presidio_anonymizer.entities import OperatorConfig

# Write path — everything, including names and places.
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

# Read path — sensitive identifiers only. Names and locations survive so
# retrieval can still match on them.
QUERY_ENTITIES = [
    "EMAIL_ADDRESS",
    "PHONE_NUMBER",
    "CREDIT_CARD",
    "US_SSN",
    "IP_ADDRESS",
    "IBAN_CODE",
    "US_BANK_NUMBER",
    "US_PASSPORT",
    "US_DRIVER_LICENSE",
]
# Public document path — pages fetched from a URL. Names and places in a
# public article aren't private data; redacting them destroys the content's
# usefulness. Contact details are still scrubbed in case a page carries them.
PUBLIC_DOC_ENTITIES = [
    "EMAIL_ADDRESS",
    "PHONE_NUMBER",
    "CREDIT_CARD",
    "US_SSN",
    "IP_ADDRESS",
    "IBAN_CODE",
    "US_BANK_NUMBER",
    "US_PASSPORT",
    "US_DRIVER_LICENSE",
]

# Presidio defaults to en_core_web_lg (400MB, downloaded at startup). We load
# sm instead — same pattern-based detection, smaller NER model.
_provider = NlpEngineProvider(nlp_configuration={
    "nlp_engine_name": "spacy",
    "models": [{"lang_code": "en", "model_name": "en_core_web_sm"}],
})

# One-time init — spaCy load is expensive
_analyzer = AnalyzerEngine(nlp_engine=_provider.create_engine())
_anonymizer = AnonymizerEngine()


def scrub(text: str, entities: list = None) -> dict:
    """
    Detect and redact PII in text.

    Args:
        text: raw input
        entities: which entity types to scrub. Defaults to DEFAULT_ENTITIES
                  (the write path). Pass QUERY_ENTITIES for incoming queries.

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