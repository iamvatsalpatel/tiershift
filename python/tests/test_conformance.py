"""The Python side of the cross-language contract in conformance/."""

from __future__ import annotations

import json

import pytest

from tiershift import CodeSignals, Signals, apply_policy, validate
from tiershift.log import LOG_FIELDS

pytestmark = pytest.mark.usefixtures("conformance_policy")


def test_fixture_policies_validate(conformance_fixture, conformance_cases, load_policy):
    for name in {conformance_fixture["policy"], *(c["policy"] for c in conformance_cases if "policy" in c)}:
        validate(load_policy(name))


def test_all_cases(conformance_fixture, conformance_cases, load_policy):
    failures = []
    for c in conformance_cases:
        policy = load_policy(c.get("policy", conformance_fixture["policy"]))
        r = apply_policy(policy, Signals.from_dict(c["signals"]), CodeSignals.from_dict(c["code_signals"]))
        if r.tier != c["expected_tier"]:
            failures.append(f'{c["name"]}: tier {r.tier!r} != {c["expected_tier"]!r}')
        for frag in c["reason_contains"]:
            if frag not in "\n".join(r.reason):
                failures.append(f'{c["name"]}: reason {r.reason!r} lacks {frag!r}')
    assert not failures, "\n".join(failures)
    assert len(conformance_cases) >= 24


def test_log_entry_shape(conformance_log_entry):
    for k in LOG_FIELDS:
        assert k in conformance_log_entry, f"missing {k}"
    assert sorted(conformance_log_entry["signals"]) == sorted(Signals.__dataclass_fields__)
    assert sorted(conformance_log_entry["code_signals"]) == sorted(CodeSignals.__dataclass_fields__)
    # round-trips through our dataclasses without loss
    assert Signals.from_dict(conformance_log_entry["signals"]).to_dict() == conformance_log_entry["signals"]
    assert json.loads(json.dumps(conformance_log_entry)) == conformance_log_entry


def test_bundled_yaml_copies_match_repo_root(repo_root):
    """The package ships copies of the root tiershift.yaml and prices.yaml. Drift fails here."""
    from importlib import resources
    for name in ("tiershift.yaml", "prices.yaml"):
        bundled = resources.files("tiershift").joinpath("data", name).read_bytes()
        root = (repo_root / name).read_bytes()
        assert bundled == root, f"python/tiershift/data/{name} differs from the repo root {name}; copy it again"
