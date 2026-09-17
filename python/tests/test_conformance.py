"""The Python side of the cross-language contract in conformance/."""

from __future__ import annotations

import json

import pytest

from tiershift import CodeSignals, Signals, apply_policy, validate
from tiershift.log import LOG_FIELDS

pytestmark = pytest.mark.usefixtures("conformance_policy")


def test_fixture_policy_validates(conformance_policy):
    validate(conformance_policy)


def test_all_cases(conformance_policy, conformance_cases):
    failures = []
    for c in conformance_cases:
        r = apply_policy(conformance_policy, Signals.from_dict(c["signals"]), CodeSignals.from_dict(c["code_signals"]))
        if r.tier != c["expected_tier"]:
            failures.append(f'{c["name"]}: tier {r.tier!r} != {c["expected_tier"]!r}')
        for frag in c["reason_contains"]:
            if frag not in "\n".join(r.reason):
                failures.append(f'{c["name"]}: reason {r.reason!r} lacks {frag!r}')
    assert not failures, "\n".join(failures)
    assert len(conformance_cases) >= 21


def test_log_entry_shape(conformance_log_entry):
    for k in LOG_FIELDS:
        assert k in conformance_log_entry, f"missing {k}"
    assert sorted(conformance_log_entry["signals"]) == sorted(Signals.__dataclass_fields__)
    assert sorted(conformance_log_entry["code_signals"]) == sorted(CodeSignals.__dataclass_fields__)
    # round-trips through our dataclasses without loss
    assert Signals.from_dict(conformance_log_entry["signals"]).to_dict() == conformance_log_entry["signals"]
    assert json.loads(json.dumps(conformance_log_entry)) == conformance_log_entry
