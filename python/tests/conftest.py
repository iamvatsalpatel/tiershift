from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
CONFORMANCE = ROOT / "conformance"


@pytest.fixture(scope="session")
def conformance_policy() -> dict:
    return yaml.safe_load((CONFORMANCE / "policy.yaml").read_text())


@pytest.fixture(scope="session")
def conformance_cases() -> list[dict]:
    return json.loads((CONFORMANCE / "cases.json").read_text())["cases"]


@pytest.fixture(scope="session")
def conformance_log_entry() -> dict:
    return json.loads((CONFORMANCE / "log-entry.json").read_text())
