# Security documents: what is where

The security-hardening brief asked for eight named deliverables and said *create or update*.
Most of them already have a canonical home in this repository, and a second copy of one
document is a second thing to disagree with the first. So this index resolves each required
name to the file that actually carries it, and the two views that had no home are written
here.

| Required deliverable | Carried by | Status |
| --- | --- | --- |
| `SECURITY_ASSESSMENT.md` — findings, severity, evidence, exploitability, remediation, residual risk | [`HARDENING.md`](../../HARDENING.md) is the findings register (each entry names the test or command that proves it, and the "Still open" list is the residual risk); [`docs/enterprise/assessment.md`](../enterprise/assessment.md) is the requirements-to-code view | existing |
| `THREAT_MODEL.md` — assets, actors, surfaces, boundaries, abuse cases, mitigations | [`docs/enterprise/security-threat-model.md`](../enterprise/security-threat-model.md) — assets, adversaries, threat-by-threat, and the controls that must not be weakened | existing |
| `SECURITY_ARCHITECTURE.md` — identities, services, sandbox, data paths, signing authority, network boundaries, environment separation | [`SECURITY_ARCHITECTURE.md`](SECURITY_ARCHITECTURE.md) | new |
| `IP_PROTECTION.md` — what is public, what is proprietary, what moved server-side, remaining exposure | [`IP_PROTECTION.md`](IP_PROTECTION.md) | new |
| `SECRETS_AND_KEY_MANAGEMENT.md` — inventory, owners, rotation, privileges, recovery without printing secrets | [`docs/runbooks/credentials-and-deploy.md`](../runbooks/credentials-and-deploy.md) (the credential table, the rotate-first rule, the box steps) with the per-service authority map in [`SECURITY_ARCHITECTURE.md`](SECURITY_ARCHITECTURE.md) | existing |
| `INCIDENT_RESPONSE.md` — playbooks and decision owners | [`docs/runbooks/incident-response.md`](../runbooks/incident-response.md), plus [`site-down.md`](../runbooks/site-down.md), [`indexer-stalled-or-reset.md`](../runbooks/indexer-stalled-or-reset.md), [`emergency-intake.md`](../runbooks/emergency-intake.md), [`treasury-security.md`](../runbooks/treasury-security.md) | existing |
| `SECURE_RELEASE_CHECKLIST.md` — CI and deployment gates | [`docs/runbooks/deploy-and-promote.md`](../runbooks/deploy-and-promote.md) (the ladder and what each gate refuses) with [`docs/audit-plan.md`](../audit-plan.md) for the mainnet release gates | existing |
| machine-readable test plan and remediation backlog with priority and owner | [`docs/gates.yml`](../gates.yml) (one entry per gate, with its owner) and [`docs/enterprise/production-checklist-300.md`](../enterprise/production-checklist-300.md) (the 300-row evidence register, each row stating what it was checked against) | existing |

**How to read a claim in any of these.** A control is worth what its verification is worth,
so each document distinguishes three things and never blurs them: *verified* (a command was
run here and its output is named), *wired but not exercised* (the code path exists and its
unit test passes, but no end-to-end run has touched it), and *open* (the control needs a
host, an account or a human decision that this repository cannot supply). `HARDENING.md`
uses the same three states, and its rule is that a gate nobody can turn red is not a control.
