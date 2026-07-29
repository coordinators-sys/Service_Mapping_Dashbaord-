"""Access gate on the service-mapping endpoint — TEMPORARY, EXPIRES 2026-08-12.

The endpoint is the actual exposure: it is the only thing that serves site
names, CCCM Site IDs and coordinates. These tests exist so that a refactor
cannot quietly re-open it, and so the fail-closed behaviour is not accidentally
inverted into fail-open — the failure mode that would republish the dataset.

Delete alongside the gate ONLY when the public/partner artefact split (PR #1)
and per-user auth (PR #2) have replaced it.
"""

from __future__ import annotations

import base64
import importlib
import sys

import pytest

MODULE = "api.service-mapping"

USER = "partner"
PASSWORD = "correct horse battery staple"


@pytest.fixture
def gate(monkeypatch):
    """The _authorized function with credentials configured."""
    monkeypatch.setenv("DASHBOARD_BASIC_AUTH_USER", USER)
    monkeypatch.setenv("DASHBOARD_BASIC_AUTH_PASSWORD", PASSWORD)
    monkeypatch.delenv("CRON_SECRET", raising=False)
    module = importlib.import_module(MODULE)
    return module._authorized


def basic(user: str, password: str) -> str:
    return "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()


def test_correct_credential_is_accepted(gate):
    assert gate(basic(USER, PASSWORD)) is True


@pytest.mark.parametrize(
    "header",
    [
        "",
        "Basic",
        "Bearer something",
        "Basic !!!not-base64!!!",
        basic(USER, "wrong"),
        basic("wrong", PASSWORD),
        basic("", ""),
        # No separator at all.
        "Basic " + base64.b64encode(b"nocolon").decode(),
    ],
    ids=["empty", "scheme only", "wrong scheme", "bad base64", "wrong password",
         "wrong user", "blank pair", "no separator"],
)
def test_everything_else_is_rejected(gate, header):
    assert gate(header) is False


def test_a_password_containing_a_colon_still_works(monkeypatch):
    """Splitting on the LAST colon would corrupt such a password and lock the
    partner out; splitting on the first is the correct reading."""
    monkeypatch.setenv("DASHBOARD_BASIC_AUTH_USER", USER)
    monkeypatch.setenv("DASHBOARD_BASIC_AUTH_PASSWORD", "a:b:c")
    monkeypatch.delenv("CRON_SECRET", raising=False)
    authorized = importlib.import_module(MODULE)._authorized
    assert authorized(basic(USER, "a:b:c")) is True


def test_unconfigured_deployment_fails_closed(monkeypatch):
    """The one behaviour that must never invert. A missing credential means
    'deny', never 'allow' — otherwise a config slip republishes the dataset."""
    monkeypatch.delenv("DASHBOARD_BASIC_AUTH_USER", raising=False)
    monkeypatch.delenv("DASHBOARD_BASIC_AUTH_PASSWORD", raising=False)
    authorized = importlib.import_module(MODULE)._authorized
    assert authorized(basic(USER, PASSWORD)) is False
    assert authorized("") is False


def test_partial_configuration_also_fails_closed(monkeypatch):
    monkeypatch.setenv("DASHBOARD_BASIC_AUTH_USER", USER)
    monkeypatch.delenv("DASHBOARD_BASIC_AUTH_PASSWORD", raising=False)
    authorized = importlib.import_module(MODULE)._authorized
    assert authorized(basic(USER, "")) is False


def test_scheduled_refresh_authenticates_as_a_service_principal(monkeypatch):
    """The daily cron carries Vercel's Bearer token, not the partner
    credential. Without this the refresh would 401 and the dashboard would go
    stale while still looking authoritative."""
    monkeypatch.setenv("DASHBOARD_BASIC_AUTH_USER", USER)
    monkeypatch.setenv("DASHBOARD_BASIC_AUTH_PASSWORD", PASSWORD)
    monkeypatch.setenv("CRON_SECRET", "s3cr3t-cron")
    authorized = importlib.import_module(MODULE)._authorized
    assert authorized("Bearer s3cr3t-cron") is True
    assert authorized("Bearer wrong") is False, "a wrong Bearer is not a fallback to open"
    # The partner credential must still work alongside it.
    assert authorized(basic(USER, PASSWORD)) is True


def test_bearer_is_rejected_when_no_cron_secret_is_configured(gate):
    """No CRON_SECRET means no service principal exists; a Bearer token must
    not become an unauthenticated bypass."""
    assert gate("Bearer anything") is False
