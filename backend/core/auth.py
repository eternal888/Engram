"""
Authentication core: password hashing, JWT tokens, current-user extraction,
password policy, and request rate limiting.

Design:
- Passwords bcrypt-hashed (never stored plain).
- JWT signed with SECRET_KEY (HS256). Token payload contains user_id + expiry.
- FastAPI dependency get_current_user extracts + validates token on every protected route.
- Password rules live here, not in the frontend, so hitting the API directly
  can't bypass them.
"""

import hashlib
import os
import time
import unicodedata
from collections import defaultdict, deque
from datetime import datetime, timedelta
from typing import Optional

import httpx
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from jose import jwt, JWTError
from passlib.context import CryptContext

# ── Config ─────────────────────────────────────────────────
# No fallback secret. A default here would be public in the repository, and a
# system that boots with a forgeable signing key is worse than one that refuses.
SECRET_KEY = os.getenv("JWT_SECRET_KEY")
if not SECRET_KEY:
    raise RuntimeError(
        "JWT_SECRET_KEY is not set. Generate one with "
        "`python -c \"import secrets; print(secrets.token_urlsafe(48))\"` "
        "and set it in .env locally and in the host's environment in production."
    )
if len(SECRET_KEY) < 32:
    raise RuntimeError("JWT_SECRET_KEY is too short — use at least 32 characters.")

ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7  # 7 days

# ── Password hashing ───────────────────────────────────────
# bcrypt reads only the first 72 bytes of its input and discards the rest, so a
# long passphrase would be hashed from its prefix. bcrypt_sha256 runs the
# password through SHA-256 first, which turns any length into a fixed 32 bytes
# before bcrypt sees it — so length is genuinely unlimited rather than capped.
#
# Plain bcrypt stays in the list so hashes written before this change still
# verify. deprecated="auto" marks them stale, and check_needs_rehash lets the
# login route upgrade them transparently on the next successful sign-in.
pwd_context = CryptContext(schemes=["bcrypt_sha256", "bcrypt"], deprecated="auto")


def hash_password(plain: str) -> str:
    return pwd_context.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def needs_rehash(hashed: str) -> bool:
    """True if this hash uses a superseded scheme and should be rewritten."""
    return pwd_context.needs_update(hashed)


# ── Password policy ────────────────────────────────────────
# Follows NIST SP 800-63B: length and a blocklist, no composition mandates, no
# forced rotation, no security questions. Composition rules reliably produce
# "Password1!", which narrows the search space rather than widening it.
#
# NIST requires a minimum of 8 and recommends 15 where a password is the only
# factor. There is no second factor here, so 12 is the midpoint taken until
# MFA exists; raising it to 15 is the upgrade, not adding symbol rules.
MIN_PASSWORD_LENGTH = 12

# NIST requires accepting at least 64 characters without truncation. With
# bcrypt_sha256 the hash is length-independent, so this ceiling exists only to
# stop a multi-megabyte request from occupying CPU in SHA-256.
MAX_PASSWORD_LENGTH = 256

# A short blocklist. A production system would load a real corpus (rockyou,
# SecLists) at startup; this covers the shapes that actually show up.
COMMON_PASSWORDS = {
    "password", "password1", "password123", "passw0rd", "qwerty", "qwerty123",
    "123456", "1234567", "12345678", "123456789", "1234567890", "12345678910",
    "letmein", "welcome", "welcome1", "admin", "administrator", "root", "toor",
    "iloveyou", "monkey", "dragon", "sunshine", "princess", "football",
    "baseball", "master", "shadow", "michael", "superman", "trustno1",
    "abc123", "abcd1234", "a1b2c3d4", "changeme", "secret", "default",
    "test1234", "temp1234", "pass1234", "login123", "hello123", "whatever",
    "engram", "engram123", "memory123", "graph123",
}


# ── Breach screening ───────────────────────────────────────
# The local list above catches the obvious shapes. This checks the password
# against Have I Been Pwned's corpus of several hundred million passwords seen
# in real breaches, which is what NIST means by screening against known
# compromised credentials.
#
# k-anonymity: only the first five characters of the SHA-1 hash are sent. The
# service returns every suffix it holds under that prefix — typically a few
# hundred — and the match is made locally. The password, and the full hash,
# never leave this process.
HIBP_URL = "https://api.pwnedpasswords.com/range/{prefix}"
HIBP_TIMEOUT = float(os.getenv("HIBP_TIMEOUT_SECONDS", "2.5"))
HIBP_ENABLED = os.getenv("HIBP_ENABLED", "true").lower() not in ("0", "false", "no")


def breach_count(password: str) -> Optional[int]:
    """
    How many times this password appears in known breaches.
    Returns None if the check could not be made — the caller decides what that
    means, rather than this function silently reporting "clean".
    """
    if not HIBP_ENABLED:
        return None

    digest = hashlib.sha1(password.encode("utf-8")).hexdigest().upper()
    prefix, suffix = digest[:5], digest[5:]

    try:
        response = httpx.get(
            HIBP_URL.format(prefix=prefix),
            timeout=HIBP_TIMEOUT,
            headers={"Add-Padding": "true", "User-Agent": "engram"},
        )
        response.raise_for_status()
    except Exception as exc:
        print(f"⚠️ breach check unavailable: {exc}")
        return None

    for line in response.text.splitlines():
        candidate, _, count = line.partition(":")
        if candidate.strip() == suffix:
            return int(count.strip() or 0)
    return 0


def _normalise(value: str) -> str:
    """Fold case and unicode form so lookalikes can't slip past the blocklist."""
    return unicodedata.normalize("NFKC", value).strip().casefold()


def validate_password(password: str, email: str = "") -> None:
    """
    Raise HTTPException(400) if the password is unacceptable.

    Enforced on the server so a direct API call can't bypass the frontend.
    """
    if not password:
        raise HTTPException(status_code=400, detail="Password is required.")

    # measured in characters, not bytes — a passphrase with accents or emoji is
    # no less valid than one without, and the hash no longer cares about size
    if len(password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(
            status_code=400,
            detail=f"Password must be at least {MIN_PASSWORD_LENGTH} characters.",
        )
    if len(password) > MAX_PASSWORD_LENGTH:
        raise HTTPException(
            status_code=400,
            detail=f"Password is too long (limit {MAX_PASSWORD_LENGTH} characters).",
        )

    folded = _normalise(password)

    if folded in COMMON_PASSWORDS:
        raise HTTPException(
            status_code=400,
            detail="That password is too common. Pick something less guessable.",
        )

    # a single repeated character, or a straight run of digits
    if len(set(folded)) <= 2:
        raise HTTPException(
            status_code=400, detail="Password is too repetitive.",
        )
    if folded.isdigit():
        raise HTTPException(
            status_code=400, detail="Password cannot be only digits.",
        )

    # the address itself is the first thing anyone tries
    local = _normalise(email.split("@")[0]) if "@" in email else _normalise(email)
    if local and len(local) >= 3 and local in folded:
        raise HTTPException(
            status_code=400,
            detail="Password cannot contain your email address.",
        )

    # Fails open by design. If the breach service is unreachable, a password
    # that passed every other rule is accepted rather than blocking signup on a
    # third party being down. The local blocklist is the floor that always runs.
    seen = breach_count(password)
    if seen:
        raise HTTPException(
            status_code=400,
            detail=(
                f"This password has appeared in {seen:,} known data breaches. "
                "Choose one that hasn't."
            ),
        )


# ── Rate limiting ──────────────────────────────────────────
# In-memory sliding window, per client address. This is honest about its
# limits: it resets when the container restarts and it does not coordinate
# across instances. For a single service it stops scripted abuse; a
# multi-instance deployment would need Redis behind the same interface.
_HITS: dict[str, deque] = defaultdict(deque)


def _client_key(request: Request) -> str:
    # honour the proxy header the host sets, since the socket address is the proxy
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def rate_limit(bucket: str, limit: int, window_seconds: int):
    """
    Dependency factory. Allows `limit` requests per `window_seconds` per client.

        @router.post("/register", dependencies=[Depends(rate_limit("register", 5, 3600))])
    """
    def dependency(request: Request) -> None:
        key = f"{bucket}:{_client_key(request)}"
        now = time.monotonic()
        hits = _HITS[key]

        while hits and now - hits[0] > window_seconds:
            hits.popleft()

        if len(hits) >= limit:
            retry_after = int(window_seconds - (now - hits[0])) + 1
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many attempts. Try again shortly.",
                headers={"Retry-After": str(retry_after)},
            )

        hits.append(now)

        # keep the dict from growing without bound on a long-lived process
        if len(_HITS) > 10_000:
            for k in [k for k, v in _HITS.items() if not v or now - v[-1] > window_seconds]:
                _HITS.pop(k, None)

    return dependency


# ── JWT tokens ─────────────────────────────────────────────
def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


# ── Current user extraction ────────────────────────────────
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


def get_current_user(token: str = Depends(oauth2_scheme)) -> str:
    """
    FastAPI dependency: extract user_id from the JWT.
    Injected into every protected endpoint. Returns the user_id string.
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id: Optional[str] = payload.get("sub")
        if user_id is None:
            raise credentials_exception
        return user_id
    except JWTError:
        raise credentials_exception