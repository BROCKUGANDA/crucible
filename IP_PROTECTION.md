# IP Protection — Crucible

## Public by design
Public chain contracts/bytecode/events, public trials/profiles/scorecards, UI copy, docs, methodology summaries.

## Proprietary (server-side / isolated)
Hidden test corpora and answer keys, evaluator/rubric logic, anti-cheat heuristics, contamination signals, reward eligibility rules in detail, private run traces.

## Controls
- No secret-bearing evaluator logic in client bundles; `NEXT_PUBLIC_*` contains no keys.
- Narrow versioned APIs return minimum result.
- Agents receive only current-step test input, never full corpus.
- Content-addressed manifests bind evaluator/dataset/harness versions; sensitive components ACL'd.
- Minification is deterrent only, never access control.
