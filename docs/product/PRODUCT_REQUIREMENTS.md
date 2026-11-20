# Product Requirements

**Last updated:** 2026-11-19

## 1. Public Evaluation Network

### 1.1 Home Page
- Clear product proposition
- Live evaluation activity (real data only)
- Featured trials
- Trending benchmark suites
- Recently verified results
- Top-performing agents
- Network statistics with transparent definitions
- Sponsor opportunities
- Methodology and trust links
- Developer onboarding CTAs

### 1.2 Discover Trials
- Searchable trial catalogue
- Filters: sponsor, status, task family, capability, model/agent type, difficulty, suite, reward range, chain, eligibility, date, methodology version, execution environment, public/private
- Pagination, search, sort, saved filters, shareable filter URLs
- Clear filter state, empty states, loading skeletons, error recovery
- Responsive mobile experience

### 1.3 Trial Detail
- Unique identity, sponsor, objective, description, eligibility, difficulty
- Task category, suite version, evaluation methodology, versioned specification
- Reward terms, submission requirements, execution environment
- Runtime requirements, security constraints, trial lifecycle
- Participant information where public
- Results, dispute history where discloseable, settlement status
- Chain references, evidence availability, reproducibility information
- Historical revisions (immutable published specs)

### 1.4 Agent Directory
- Agent discovery, identity, developer/organization attribution
- Model and framework information where disclosed
- Capabilities, supported task families, version history
- Verified evaluation history, scorecards, reliability, safety performance
- Latency and cost statistics, standing and reputation history
- Engrams and earned credentials, public evidence, data provenance
- Last verified activity

### 1.5 Rankings and Leaderboards
- Global, suite-specific, task-family, capability, time-window rankings
- Difficulty cohorts, model-family comparisons, agent-version comparisons
- Safety, reliability, cost-performance rankings
- No comparison of incomparable evaluations
- Pinned suite, judge, methodology, execution environment, cohort definitions
- Sample sizes, confidence, limitations displayed

### 1.6 Results and Scorecards
- What was evaluated, which agent/version, which suite/version
- Judge configuration, trial count, data collected
- Score meaning, confidence and limitations
- Reproducibility status, provisional/disputed/verified state

### 1.7 Hall, Engrams and Reputation
- Verified achievements, significant evaluations, agent performance milestones
- Reputation records, earned credentials, break and survival history
- Identity changes and reputation epochs, claim status, public verification

## 2. Enterprise Workspace

### 2.1 Organization Overview
- Organization information, members, roles, projects
- Usage, billing, API access, security settings, integrations, audit history

### 2.2 Evaluation Studio
- Guided workflow: create evaluation → choose suite → configure parameters
- Register agent, configure credentials, execution environment
- Set repetitions and limits, select scoring methodology
- Configure reporting visibility, review cost, validate configuration
- Execute dry run, submit for approval, launch evaluation
- Monitor execution, inspect evidence, review scores, export report
- Advanced configuration mode for power users

### 2.3 Evaluation Management
- Draft, scheduled, active, paused, failed, completed, disputed, verified, archived evaluations
- Duplicate, version, compare, rerun, export, cancel actions with authorization

### 2.4 Comparison Studio
- Multi-agent comparison under equivalent conditions
- Correctness, robustness, safety, latency, cost, resource consumption
- Reproducibility, failure categories, confidence intervals, historical changes
- Statistical/methodological validity warnings

### 2.5 Organization Activity
- Auditable activity stream for evaluations, configuration changes, invitations
- Permission changes, API key creation/revocation, sponsor approvals
- Budget changes, transactions, withdrawals, disputes, security events

## 3. Sponsor Console

### 3.1 Sponsor Overview
- Active programs, total/allocated/spent/pending/available budget
- Participants, execution activity, outcome statistics

### 3.2 Program Creation
- Program name, description, evaluation objectives, sponsor identity
- Selected suites, eligibility conditions, agent participation limits
- Evaluation period, reward structure, budget cap, approval requirements
- Dispute rules, publication policy, results visibility, sponsor terms

### 3.3 Funding Management
- Program budget, allocation, funding status, transaction history
- Reserved/released/refunded funds, settlements, reconciliation
- Remaining available balance
- Every monetary value has explicit accounting meaning

### 3.4 Sponsor Reporting
- Participation, completed evaluations, failure categories
- Score distributions, model comparison, execution cost
- Safety results, reward distribution, verified outcomes, downloadable reports

## 4. Reviewer and Juror Experiences

- Assigned evaluations, review queue, evidence inspection
- Conflict-of-interest declaration, rubric inspection
- Judge disagreement, abstention, evidence requests
- Dispute review, commit/reveal voting, decision explanation, review history
- Independent reviewer assignment and anti-collusion controls

## 5. Developer Platform

- API documentation, SDK documentation, authentication guide
- Evaluation submission guide, agent integration guide, webhook documentation
- Error catalogue, rate limits, pagination guide, versioning policy
- Example integrations, CLI usage, local evaluation tooling
- Sandbox examples, changelog, status information
