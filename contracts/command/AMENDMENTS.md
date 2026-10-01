# Adoption clarifications

Baseline comparison: authorized checkout equals 454e7ac; no newer source assumptions to preserve.

SPEC-15 R-13 now explicitly orders same-stage configuration-mismatch before unauthorized and invalid-arguments before missing-support before unexpected-support. Count limits precede decode; all decode precedes aggregate canonical size checks, which precede ID/signature verification. This resolves packet-order-dependent error priority; it preserves the specified cross-stage order. Independent contract review prompted this clarification, approved by the supervisor.

R-08 selects the smallest canonical signature bytes after verifying every appearance when a supplied ID has multiple valid signatures. It preserves that supplied delta verbatim and never replaces an already admitted row. This fixes delivery-order-dependent journal heads without requiring signatures to be unique.

R-20/R-23 bind explicit variables in all reached reading predicates, including top-level, embedded and expanded readings and local `fix` environments. Execution keeps original selected definition and registry pin identities. Bound author-order regressions return height 42, matching their literal controls.

R-22 rejects the wrong signed definition kind in a selected top-level slot as early `invalid-definition`, before pins and closure checks. A correctly typed HyperSchema containing a non-executable term remains late `invalid-program`; a wrong pin on that correctly typed definition still wins before program-sort failure.
