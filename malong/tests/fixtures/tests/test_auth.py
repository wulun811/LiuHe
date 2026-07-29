import pytest
from unittest.mock import patch, MagicMock
from src.auth import login, get_user


def test_login_success():
    result = login({"user": "alice", "pass": "secret"})
    assert result["status"] == 200


def test_login_mfa():
    result = login({"user": "bob"}, require_mfa=True)
    assert result["status"] == 200


def test_login_empty():
    with pytest.raises(ValueError):
        login({})


def test_get_user():
    user = get_user(1)
    assert user["id"] == 1


@patch('src.auth.login')
def test_login_mock(mock_login):
    mock_login.return_value = "token_string"
    result = mock_login({"user": "test"})
    assert result == "token_string"
