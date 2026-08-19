"""
Shared Anthropic client.

Every agent that calls Claude imports the client from here rather than
constructing its own. Two reasons:

  1. Timeout and retry policy is set in one place. The library defaults are
     a 600-second timeout with 2 retries — a single hung call can occupy a
     worker for half an hour. On a metered host that is billed time spent
     doing nothing, and any agent that forgets to override it reintroduces
     the problem silently.

  2. Model selection lives next to it. Switching extraction to a cheaper
     model becomes an environment variable rather than an edit in four files.

Values are read from the environment so the eval harness can sweep them
without code changes, consistent with the contradiction agent's config.
"""

import os

import anthropic

from backend.core.config import ANTHROPIC_API_KEY

# 120s matches the orchestrator's existing setting. With max_retries=2 the
# true worst case is three attempts — roughly six minutes — which is the
# number to keep in mind, not 120.
TIMEOUT = float(os.getenv("ANTHROPIC_TIMEOUT", "120.0"))
MAX_RETRIES = int(os.getenv("ANTHROPIC_MAX_RETRIES", "2"))

# Model defaults. These currently match what is hardcoded at each call site;
# call sites are not yet wired to read them, so changing these has no effect
# until that follow-up lands.
MODEL_DEFAULT = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-5")
MODEL_EXTRACTION = os.getenv("EXTRACTION_MODEL", MODEL_DEFAULT)
MODEL_GROUNDING = os.getenv("GROUNDING_MODEL", MODEL_DEFAULT)
MODEL_RESPONSE = os.getenv("RESPONSE_MODEL", MODEL_DEFAULT)

client = anthropic.Anthropic(
    api_key=ANTHROPIC_API_KEY,
    timeout=TIMEOUT,
    max_retries=MAX_RETRIES,
)