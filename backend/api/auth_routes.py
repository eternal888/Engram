"""
Auth endpoints:
    POST /api/auth/register  → create user
    POST /api/auth/login     → get JWT token
    GET  /api/auth/me        → who am I (verifies token)

Registration + login are the only two routes that don't require a token.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel, EmailStr, Field
from backend.graph.users import create_user, authenticate_user, get_user_by_id
from backend.core.auth import create_access_token, get_current_user

router = APIRouter(prefix="/auth", tags=["auth"])


# ── Models ────────────────────────────────────────────────
class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=8, description="Min 8 chars")


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user_id: str
    email: str


class UserResponse(BaseModel):
    id: str
    email: str


# ── Endpoints ─────────────────────────────────────────────
@router.post("/register", response_model=TokenResponse)
def register(request: RegisterRequest):
    """Create a user and return a fresh token so they're logged in immediately."""
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


@router.post("/login", response_model=TokenResponse)
def login(form_data: OAuth2PasswordRequestForm = Depends()):
    """
    Login with email (as 'username' per OAuth2 form spec) + password.
    Returns JWT on success. Uniform error message on any failure.
    """
    user = authenticate_user(form_data.username, form_data.password)
    if not user:
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