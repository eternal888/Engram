"""
User storage layer.

Users live as :User nodes in Neo4j:
    User { id, email, password_hash, created_at }

- id is a UUID; used as user_id in every other node (Episode/Concept/Entity/etc.)
- email is unique — enforced at write time
- password_hash is bcrypt (never plain)
"""

import uuid
from datetime import datetime
from typing import Optional
from backend.graph.graph_client import graph_client
from backend.core.auth import hash_password, verify_password


def create_user(email: str, password: str) -> dict:
    """
    Register a new user. Fails if email already exists.
    Returns {id, email} on success. Raises ValueError if email taken.
    """
    existing = graph_client.run(
        "MATCH (u:User {email: $email}) RETURN u.id as id",
        {"email": email.lower()}
    )
    if existing:
        raise ValueError("Email already registered")

    user_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()

    graph_client.run("""
        CREATE (u:User {
            id: $id,
            email: $email,
            password_hash: $password_hash,
            created_at: $now
        })
        """, {
        "id": user_id,
        "email": email.lower(),
        "password_hash": hash_password(password),
        "now": now
    })

    return {"id": user_id, "email": email.lower()}


def authenticate_user(email: str, password: str) -> Optional[dict]:
    """
    Verify email + password. Returns {id, email} on success, None on failure.
    Same error message for missing user vs wrong password — no info leak.
    """
    result = graph_client.run("""
        MATCH (u:User {email: $email})
        RETURN u.id as id, u.email as email, u.password_hash as password_hash
        """, {"email": email.lower()})

    if not result:
        return None

    user = result[0]
    if not verify_password(password, user["password_hash"]):
        return None

    return {"id": user["id"], "email": user["email"]}


def get_user_by_id(user_id: str) -> Optional[dict]:
    """Fetch user record — used to verify tokens still map to real users."""
    result = graph_client.run(
        "MATCH (u:User {id: $id}) RETURN u.id as id, u.email as email",
        {"id": user_id}
    )
    return result[0] if result else None