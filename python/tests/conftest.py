from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
CONFORMANCE = ROOT / "conformance"


@pytest.fixture(scope="session")
def conformance_fixture() -> dict:
    """The whole cases.json: top-level `policy` plus `cases`, each of which may name its own `policy`."""
    return json.loads((CONFORMANCE / "cases.json").read_text())


@pytest.fixture(scope="session")
def load_policy():
    cache: dict[str, dict] = {}

    def _load(name: str) -> dict:
        if name not in cache:
            cache[name] = yaml.safe_load((CONFORMANCE / name).read_text())
        return cache[name]
    return _load


@pytest.fixture(scope="session")
def conformance_policy(conformance_fixture, load_policy) -> dict:
    return load_policy(conformance_fixture["policy"])


@pytest.fixture(scope="session")
def conformance_cases(conformance_fixture) -> list[dict]:
    return conformance_fixture["cases"]


@pytest.fixture(scope="session")
def conformance_log_entry() -> dict:
    return json.loads((CONFORMANCE / "log-entry.json").read_text())


@pytest.fixture(scope="session")
def repo_root() -> Path:
    return ROOT
