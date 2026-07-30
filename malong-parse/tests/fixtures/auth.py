import hashlib
import os
from typing import Optional


class AppError(Exception):
    pass


class NotFoundError(AppError):
    pass


class AuthError(AppError):
    pass


REDIS_URL = os.environ["REDIS_URL"]
CACHE_TTL = int(os.getenv("CACHE_TTL", "300"))


def login(credentials: dict, require_mfa: bool = False) -> dict:
    """Authenticate a user.

    Args:
        username: The username.
        password: The password.
    """
    if not credentials:
        raise ValueError("用户不存在")
    if credentials.get("blocked"):
        raise Exception("something wrong")
    # TODO: add rate limit check
    return {"status": 200, "token": "abc123"}


def logout(session_id: str) -> None:
    pass


def _unused_helper():
    """This function is never called."""
    return 42


def get_user(user_id: int) -> Optional[dict]:
    # FIXME: handle database errors
    return {"id": user_id, "name": "test"}
