---
type: Added
pr: 0
---
Add a Codex PreToolUse guard that blocks executor dispatch only when phase preflight finds existing work, while failing open for unavailable evidence.
<!-- docs-exempt: Codex-native companion to gsd-phase-dispatch-guard.js — same internal safety-hook class, same exemption rationale (see that hook's own changeset fragment). -->

