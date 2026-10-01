# Adoption clarifications

Baseline comparison: authorized checkout equals 454e7ac; no newer source assumptions to preserve.

SPEC-15 R-13 now explicitly orders same-stage configuration-mismatch before unauthorized and invalid-arguments before missing-support before unexpected-support. Count limits precede decode; all decode precedes aggregate canonical size checks, which precede ID/signature verification. This resolves packet-order-dependent error priority; it preserves the specified cross-stage order. Independent contract review prompted this clarification, approved by the supervisor.
