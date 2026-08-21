"""
Auth endpoints:
    POST /api/auth/register  → create user
    POST /api/auth/login     → get JWT token
    GET  /api/auth/me        → who am I (verifies token)

Registration + login are the only two routes that don't require a token, which
is why they carry rate limits: they are the only surface an anonymous caller can
reach, and both are cheap to script against.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel, EmailStr, Field

from backend.graph.users import create_user, authenticate_user, get_user_by_id
from backend.core.auth import (
    create_access_token,
    get_current_user,
    rate_limit,
    validate_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])

# Five registrations an hour is generous for a person and useless for a script.
# Login is looser because a typo shouldn't lock anyone out, but still bounded —
# bcrypt makes a single guess slow, this caps how many can be attempted at all.
register_limit = rate_limit("register", limit=5, window_seconds=3600)
login_limit = rate_limit("login", limit=10, window_seconds=600)


# ── Models ────────────────────────────────────────────────
class RegisterRequest(BaseModel):
    email: EmailStr
    # Length is checked in validate_password, not here, so the caller gets one
    # clear message instead of a pydantic validation blob. The max is a guard
    # against a large body reaching the hash function at all.
    password: str = Field(..., max_length=256)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user_id: str
    email: str


class UserResponse(BaseModel):
    id: str
    email: str


# ── Endpoints ─────────────────────────────────────────────
@router.post("/register", response_model=TokenResponse,
             dependencies=[Depends(register_limit)])
def register(request: RegisterRequest):
    """Create a user and return a fresh token so they're logged in immediately."""
    # Server-side, so a direct API call can't skip what the frontend checks.
    validate_password(request.password, request.email)

    try:
        user = create_user(request.email, request.password)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    token = create_access_token({"sub": user["id"]})
    return TokenResponse(
        access_token=token,
        user_id=user["id"],
        email=user["email"]
    )


@router.post("/login", response_model=TokenResponse,
             dependencies=[Depends(login_limit)])
def login(form_data: OAuth2PasswordRequestForm = Depends()):
    """
    Login with email (as 'username' per OAuth2 form spec) + password.
    Returns JWT on success. Uniform error message on any failure.
    """
    user = authenticate_user(form_data.username, form_data.password)
    if not user:
        # Same response whether the address is unknown or the password is wrong.
        # Distinguishing them would confirm which addresses have accounts.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = create_access_token({"sub": user["id"]})
    return TokenResponse(
        access_token=token,
        user_id=user["id"],
        email=user["email"]
    )


@router.get("/me", response_model=UserResponse)
def me(current_user_id: str = Depends(get_current_user)):
    """Return the current user's info. Useful for the frontend to verify a stored token."""
    user = get_user_by_id(current_user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return UserResponse(id=user["id"], email=user["email"])