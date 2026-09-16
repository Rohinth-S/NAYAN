"""Generated policy registry. Do not edit by hand.

Produced by scripts/generate-policy-registry.py from
server/app/detector-registry.json and governance/protocol-manifest.json.
"""

from __future__ import annotations

PROTOCOL_VERSION = "1.0"
REGISTRY_VERSION = "1.1.0"
REGISTRY_DIGEST = "sha256:839a8d0a22a6b6f44e0645f64685121d894237405ef9bebdc4bb43e063aa449e"
MINIMUM_GRADES: dict[str, int] = {
    "credential": 1,
    "government-id": 1,
    "financial": 1,
    "biometric": 1,
    "custom": 1,
    "uninspectable": 1,
    "contact": 2,
    "location": 2,
    "date-of-birth": 2,
    "network": 2,
    "account-id": 2,
    "name": 3,
    "username": 3,
    "professional-id": 3,
    "unknown-populated-field": 3,
}
INVARIANT_CATEGORIES: tuple[str, ...] = (
    "credential",
    "government-id",
    "financial",
    "biometric",
    "custom",
    "uninspectable",
)
