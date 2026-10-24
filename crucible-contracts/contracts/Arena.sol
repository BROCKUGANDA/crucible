// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Params} from "./Params.sol";

/// @title Arena — the v2 adversarial escrow (ADR-0011, bible §6–§7, gates 734–746).
/// @notice Sponsors post paid trials in native ETH, agents bond and submit signed run
/// artifacts, skeptics stake against a pass with sealed breaks, and a bonded Argus panel
/// drawn by `ArgusCourt` settles disputes. Every number comes from `Params.sol`, which is
/// generated from `params/crucible.params.json` and drift-gated in CI (gate 732).
///
/// What this deliberately is NOT:
/// - Not the legacy escrow. `CrucibleTrials.sol` keeps its 5% fee taken from the agent's
///   payout, one break per trial, three fixed seats and the 50/50 failed-stake split. That is
///   frozen law (ADR-0002, contract-spec.md §5) and nothing here shares a slot with it. The
///   arena's 15% is paid by the sponsor on top of R, and it is a different contract.
/// - Not a USDC/SOL escrow. ADR-0002 keeps the arena native-ETH; the per-mint floors in the
///   params file have no home here and are recorded as a deviation in DECISIONS.md.
/// - Not a push-payment contract. Settlement only credits; `withdraw()` is the single
///   `{value:}` site, behind the same hand-rolled guard the legacy escrow uses (ADR-0003).
/// - Not a privileged settlement path. The owner wires attestor keys and nothing else; no key
///   can settle early, redirect a payout, or block an exit. Every state has a cranks-only exit.
contract Arena {
    // ───────────────────────── types ──────────────────────────
    enum Status {
        Open, // posted, unclaimed
        Claimed, // bonded agent, claim deadline running
        Submitted, // pass recorded, skeptic window open
        Docketed, // window + grace closed, breaks ranked
        Panel, // seats drawn, voting
        Settled // terminal
    }

    /// @notice The bible §7.2 outcome table. O4 and O5 are non-terminal exits — the trial
    /// goes back to Open, or to Expired — so they are reported by `ExitRecorded` and never
    /// written into `outcome`, which only ever means "this trial is finished".
    enum Outcome {
        None,
        O1, // pass, no revealed break
        O2, // every docket break failed
        O3, // at least one break landed
        O4, // agent yielded
        O5, // claim timed out
        O6, // expired unclaimed
        O7, // cancelled before any claim
        O8 // no quorum after MAX_ARGUS_ROUNDS panels
    }

    /// @notice Break kinds (§6.3). The first three are mechanical: a seat whose replay hash
    /// disagrees with the canonical replay has its vote voided at reveal.
    enum BreakKind {
        PublicFail,
        HoldoutFail,
        ReplayMismatch,
        Provenance,
        SpecViolation
    }

    enum Vote {
        Upheld,
        Rejected,
        Abstain
    }

    struct Trial {
        address sponsor;
        Status status;
        Outcome outcome;
        uint128 reward; // R
        uint72 fee; // F = R × ARENA_FEE_BPS ÷ BPS, frozen at post
        uint72 bond; // B, escrowed at claim
        uint40 openedAt;
        uint40 openUntil; // unclaimed expiry (O6)
        uint40 claimDeadline; // set at claim (O5)
        uint40 submittedAt;
        uint40 windowEnd; // end of the skeptic window
        uint40 holdoutDueBy; // HOLDOUT_REVEAL_MAX, measured from submit
        uint32 skepticWindow;
        uint8 round; // 1-based panel round
        bool holdoutRevealed;
        bool holdoutMissed;
        bool docketFrozen;
        bool everClaimed; // survives a yield: cancel is about who could have relied on the claim
        bool activeCounted; // whether _activeClaim holds one for this trial's agent
        address agent;
        address runner;
        bytes32 specDigest;
        bytes32 suiteDigest;
        bytes32 holdoutCommitment;
        bytes32 holdoutDigest; // set by revealHoldout
        bytes32 runHash; // sha256(JCS(RunArtifact))
        bytes32 verdictHash;
        bytes32 replayHash; // sha256 over the three replay verdict hashes
        bytes32 modelHarnessId;
        uint256 deposited; // ghost ledger: every wei this trial ever brought in
        uint256 paidOut; // ghost ledger: every wei credited back out of it
    }

    struct Break {
        address skeptic;
        bytes32 commitment;
        bytes32 evidence; // set on reveal
        uint128 stake; // S
        uint64 seatFee; // A, this break's seat-fee pool: ARGUS_SEATS × SEAT_FEE_BPS of R
        uint40 committedAt;
        BreakKind kind;
        uint8 decidedRound; // which panel actually settled this row, 0 until it has
        bool revealed;
        bool onDocket;
        bool landed;
        bool decided;
        bool settled; // its money has been routed once
    }

    struct Panel {
        address[3] seats;
        uint40 drawnAt;
        uint8 seatCount;
    }

    // ───────────────────────── errors ─────────────────────────
    error NotOwner();
    error NotSponsor();
    error NotAgent();
    error NotRunner();
    error NotAttestor();
    error NotSeat();
    error SelfClaim();
    error SelfBreak();
    error ZeroAddress();
    error TooSmall();
    error RewardTooSmall();
    error RewardMismatch();
    error BadWindow();
    error BadOpenSpan();
    error BadDeadline();
    error BadState();
    error AlreadyClaimed();
    error ClaimWindowClosed();
    error TooManyActiveClaims();
    error YieldCooldown();
    error NoRunner();
    error HoldoutUnknown();
    error HoldoutAlreadyRevealed();
    error HoldoutDeadlinePassed();
    error HoldoutCommitmentMismatch();
    error WindowStillOpen();
    error RevealWindowClosed();
    error BreakUnknown();
    error TooManyBreaks();
    error AlreadyRevealed();
    error StakeTooSmall();
    error SeatFeeWrong();
    error DocketAlreadyFrozen();
    error PanelNotDrawn();
    error PanelAlreadyDrawn();
    error RoundTooLate();
    error CommitClosed();
    error AlreadyCommitted();
    error AlreadyRevealedVote();
    error CommitMismatch();
    error VoteLen();
    error TallyOpen();
    error BondShortfall();
    error NothingToWithdraw();
    error TransferFailed();
    error BadSigLength();
    error SigMalleable();
    error BadSigner();
    error AttestationNotPassed();
    error SigExpired();
    error NonceReplayed();
    error DigestMismatch();
    error RandomnessNotConfigured();
    error BadDraw();

    // ───────────────────────── events ─────────────────────────
    event TrialPosted(
        uint256 indexed id,
        address indexed sponsor,
        uint256 reward,
        uint256 fee,
        bytes32 specDigest,
        uint32 skepticWindow
    );
    event TrialClaimed(uint256 indexed id, address indexed agent, uint256 bond, uint256 claimDeadline);
    event RunnerSet(uint256 indexed id, address indexed runner);
    event Yielded(uint256 indexed id, address indexed agent);
    event ClaimTimedOut(uint256 indexed id, address indexed agent, uint256 forfeit, bool reopened);
    event Cancelled(uint256 indexed id, address indexed sponsor);
    event Expired(uint256 indexed id, address indexed sponsor);
    event HoldoutRevealed(uint256 indexed id, bytes32 holdoutDigest);
    event HoldoutMissed(uint256 indexed id);
    event RunSubmitted(
        uint256 indexed id, address indexed agent, bytes32 runHash, bytes32 verdictHash, bytes32 replayHash
    );
    event BreakCommitted(
        uint256 indexed id, uint256 indexed index, address indexed skeptic, uint256 stake, uint256 seatFee
    );
    event BreakRevealed(uint256 indexed id, uint256 indexed index, uint8 kind, bytes32 evidence);
    event DocketFrozen(uint256 indexed id, uint256 docketSize);
    event PanelDrawn(
        uint256 indexed id, uint8 indexed round, address seat0, address seat1, address seat2, bool devnetRandomness
    );
    event VoteCommitted(uint256 indexed id, uint8 indexed round, address indexed seat);
    event VoteRevealed(uint256 indexed id, uint8 indexed round, address indexed seat, bytes32 votesHash);
    event SeatSlashed(uint256 indexed id, uint8 indexed round, address indexed seat);
    event BreakTallied(
        uint256 indexed id, uint8 indexed round, uint256 indexed breakIndex, uint8 upheld, uint8 rejected, bool landed
    );
    event ExitRecorded(uint256 indexed id, Outcome outcome);
    event Settled(
        uint256 indexed id, Outcome outcome, uint256 agentCredit, uint256 sponsorCredit, uint256 treasuryCredit
    );
    event Credited(address indexed to, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event AttestorSet(address indexed attestor, bool allowed);

    // ───────────────────────── constants ──────────────────────
    uint256 public constant BPS = Params.BPS;

    /// @notice The bound on filings per trial. Without it `freezeDocket`'s ranking pass is
    /// O(revealed × MAX_DOCKET) over a list any griefer can lengthen, and "unlimited filing,
    /// bounded judging" (§6.3.2) becomes an unbounded gas bill for whoever cranks it.
    uint256 public constant MAX_FILING = 64;

    uint256 private constant _SECP256K1_HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    // ───────────────────────── storage ────────────────────────
    address public immutable owner;
    address public immutable treasury;
    ArgusCourtPublic public immutable court;

    /// @notice 0 = deterministic devnet draw, labelled in `PanelDrawn`; 1 = refuse to draw at
    /// all until a VRF consumer exists. Fail-closed, because an oracle that cannot be wired
    /// should stop the panel rather than hand a whale a predictable jury (D-12, T8).
    uint8 public immutable randomnessMode;

    uint256 private _nextId = 1;
    mapping(uint256 => Trial) private _trials;
    mapping(uint256 => Break[]) private _breaks;
    mapping(uint256 => mapping(uint8 => Panel)) private _panels;
    mapping(uint256 => mapping(uint8 => mapping(address => bytes32))) private _voteCommit;
    mapping(uint256 => mapping(uint8 => mapping(address => bytes))) private _voteReveal;
    mapping(uint256 => mapping(uint8 => mapping(address => bool))) private _voteVoid;
    /// @dev One slash per seat per panel. Without this, every extra crank of `tally` charged a
    /// no-show 20% again, and a stranger could empty a seat's bond by calling the same function.
    mapping(uint256 => mapping(uint8 => mapping(address => bool))) private _slashed;
    mapping(uint256 => mapping(address => uint40)) private _yieldedAt;

    mapping(address => uint256) public credit;
    mapping(address => uint256) public withdrawn;
    mapping(address => uint256) public activeClaimsOf;
    mapping(address => bool) public isAttestor;
    mapping(address => uint64) private _lastNonce;

    uint256 public totalPending;
    uint256 public totalDeposited;
    uint256 public totalWithdrawn;

    uint256 private _guard;

    modifier notReentrant() {
        if (_guard == 0) revert TransferFailed();
        _guard = 0;
        _;
        _guard = 1;
    }

    // ───────────────────────── EIP-712 ────────────────────────
    bytes32 public constant RUN_TYPEHASH = keccak256(
        "Run(bytes32 trialId,address agent,bytes32 artifactDigest,bytes32 verdictHash,bytes32 replayHash,bytes32 modelHarnessId,uint64 nonce,uint64 sigDeadline)"
    );
    bytes32 public constant ATTEST_TYPEHASH = keccak256(
        "ResultAttestation(bytes32 trialId,bytes32 artifactDigest,bytes32 verdictHash,bytes32 replayHash,bool passed,uint64 sigDeadline)"
    );
    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public immutable DOMAIN;

    constructor(address treasury_, address court_, uint8 randomnessMode_) {
        if (treasury_ == address(0) || court_ == address(0)) revert ZeroAddress();
        owner = msg.sender;
        treasury = treasury_;
        court = ArgusCourtPublic(court_);
        randomnessMode = randomnessMode_;
        _guard = 1;
        DOMAIN = keccak256(
            abi.encode(_DOMAIN_TYPEHASH, keccak256("CRUCIBLE"), keccak256("2"), block.chainid, address(this))
        );
    }

    /// @notice Wire or unwire an attestor key. This decides who may vouch that a run passed.
    /// It cannot move one wei, which is the whole reason it is the only privileged surface.
    function setAttestor(address attestor, bool allowed) external {
        if (msg.sender != owner) revert NotOwner();
        if (attestor == address(0)) revert ZeroAddress();
        isAttestor[attestor] = allowed;
        emit AttestorSet(attestor, allowed);
    }

    // ───────────────────────── stage I — Porta ────────────────
    /// @notice Post a trial and escrow R + F. R is an argument, not derived from msg.value:
    /// recovering it by division would make the exact sum depend on rounding direction, and a
    /// money entry point should not have a rounding debate attached to it.
    function postTrial(
        uint256 reward,
        bytes32 specDigest,
        bytes32 suiteDigest,
        bytes32 holdoutCommitment,
        uint32 skepticWindow,
        uint40 openSpan
    ) external payable returns (uint256 id) {
        if (specDigest == bytes32(0) || suiteDigest == bytes32(0)) revert TooSmall();
        if (skepticWindow < Params.SKEPTIC_WINDOW_MIN_SECONDS || skepticWindow > Params.SKEPTIC_WINDOW_MAX_SECONDS) {
            revert BadWindow();
        }
        if (openSpan == 0 || openSpan > Params.TRIAL_OPEN_MAX_SECONDS) revert BadOpenSpan();
        if (reward < Params.REWARD_FLOOR_WEI) revert RewardTooSmall();

        uint256 fee = (reward * Params.ARENA_FEE_BPS) / BPS; // floor: the remainder stays with the sponsor
        if (msg.value != reward + fee) revert RewardMismatch();

        id = _nextId++;
        Trial storage t = _trials[id];
        t.sponsor = msg.sender;
        t.status = Status.Open;
        t.reward = uint128(reward);
        t.fee = uint72(fee);
        t.openedAt = uint40(block.timestamp);
        t.openUntil = uint40(block.timestamp + openSpan);
        t.skepticWindow = skepticWindow;
        t.specDigest = specDigest;
        t.suiteDigest = suiteDigest;
        t.holdoutCommitment = holdoutCommitment;
        t.deposited = reward + fee;
        totalDeposited += reward + fee;
        emit TrialPosted(id, msg.sender, reward, fee, specDigest, skepticWindow);
    }

    /// @notice Cancel while Open and never claimed: R + F back to the sponsor (O7). Once an
    /// agent has held a claim here, only the time exits remain — a sponsor could otherwise
    /// liquidate a losing position.
    function cancelTrial(uint256 id) external {
        Trial storage t = _trials[id];
        if (t.sponsor != msg.sender) revert NotSponsor();
        if (t.everClaimed) revert BadState();
        if (t.status != Status.Open) revert BadState();
        t.status = Status.Settled;
        t.outcome = Outcome.O7;
        uint256 amount = uint256(t.reward) + t.fee;
        t.paidOut += amount;
        _credit(t.sponsor, amount);
        emit ExitRecorded(id, Outcome.O7);
        emit Cancelled(id, msg.sender);
        emit Settled(id, Outcome.O7, 0, amount, 0);
    }

    /// @notice Permissionless: an unclaimed trial past `openUntil` refunds R + F (O6).
    function expireTrial(uint256 id) external {
        Trial storage t = _trials[id];
        if (t.status != Status.Open) revert BadState();
        if (block.timestamp < t.openUntil) revert WindowStillOpen();
        t.status = Status.Settled;
        t.outcome = Outcome.O6;
        uint256 amount = uint256(t.reward) + t.fee;
        t.paidOut += amount;
        _credit(t.sponsor, amount);
        emit ExitRecorded(id, Outcome.O6);
        emit Expired(id, t.sponsor);
        emit Settled(id, Outcome.O6, 0, amount, 0);
    }

    // ───────────────────────── stage II — Sacramentum ─────────
    /// @notice Claim and bond: B ≥ AGENT_BOND_MIN_BPS of R, escrowed here, deadline set.
    function claimTrial(uint256 id) external payable {
        Trial storage t = _trials[id];
        if (t.status != Status.Open) revert AlreadyClaimed();
        if (block.timestamp >= t.openUntil) revert ClaimWindowClosed();
        if (msg.sender == t.sponsor) revert SelfClaim();
        if (activeClaimsOf[msg.sender] >= Params.MAX_ACTIVE_CLAIMS) revert TooManyActiveClaims();
        if (
            _yieldedAt[id][msg.sender] + Params.YIELD_COOLDOWN_SECONDS > block.timestamp
                && _yieldedAt[id][msg.sender] != 0
        ) {
            revert YieldCooldown();
        }

        uint256 bondMin = (uint256(t.reward) * Params.AGENT_BOND_MIN_BPS) / BPS;
        if (msg.value < bondMin || msg.value > type(uint72).max) revert StakeTooSmall();

        t.status = Status.Claimed;
        t.everClaimed = true;
        t.agent = msg.sender;
        t.bond = uint72(msg.value);
        t.claimDeadline = uint40(block.timestamp + _claimSpan(t));
        t.deposited += msg.value;
        t.activeCounted = true;
        totalDeposited += msg.value;
        activeClaimsOf[msg.sender] += 1;
        emit TrialClaimed(id, msg.sender, msg.value, t.claimDeadline);
    }

    /// @dev The shorter of the trial's remaining life and CLAIM_DEADLINE_MAX: a 30-day-open
    /// trial must not hand one agent four weeks of squatting (T22, gate 736).
    function _claimSpan(Trial storage t) internal view returns (uint256) {
        uint256 remaining = t.openUntil > block.timestamp ? t.openUntil - block.timestamp : 0;
        if (remaining < Params.CLAIM_DEADLINE_MIN_SECONDS) return remaining;
        return remaining < Params.CLAIM_DEADLINE_MAX_SECONDS ? remaining : Params.CLAIM_DEADLINE_MAX_SECONDS;
    }

    /// @notice Point this trial's claim at the runner key that will sign its artifacts.
    function setRunner(uint256 id, address runner) external {
        Trial storage t = _trials[id];
        if (t.agent != msg.sender) revert NotAgent();
        if (t.status != Status.Claimed) revert BadState();
        if (runner == address(0)) revert ZeroAddress();
        t.runner = runner;
        emit RunnerSet(id, runner);
    }

    /// @notice Walk away early (O4): the bond returns, the trial reopens, and the only cost is
    /// Standing plus a cooldown — YIELD_FORFEIT_BPS is 0 by D-3, so no ETH moves to anyone.
    function yieldTrial(uint256 id) external {
        Trial storage t = _trials[id];
        if (t.agent != msg.sender) revert NotAgent();
        if (t.status != Status.Claimed) revert BadState();
        address agent = t.agent;
        uint256 bond = t.bond;

        t.paidOut += bond;
        _credit(agent, bond);
        _releaseClaim(t);
        t.status = Status.Open;
        t.agent = address(0);
        t.runner = address(0);
        t.bond = 0;
        t.claimDeadline = 0;
        _yieldedAt[id][agent] = uint40(block.timestamp);
        emit ExitRecorded(id, Outcome.O4);
        emit Yielded(id, agent);
    }

    /// @notice Permissionless exit for a stalled claim (O5). The sponsor takes
    /// CLAIM_TIMEOUT_FORFEIT_BPS of the bond, the agent keeps the rest, and the trial either
    /// reopens or, its own window gone, refunds R + F.
    function claimTimeout(uint256 id) external {
        Trial storage t = _trials[id];
        if (t.status != Status.Claimed) revert BadState();
        if (block.timestamp < t.claimDeadline) revert WindowStillOpen();
        address agent = t.agent;
        uint256 bond = t.bond;
        uint256 forfeit = (bond * Params.CLAIM_TIMEOUT_FORFEIT_BPS) / BPS;

        t.paidOut += bond;
        _credit(t.sponsor, forfeit);
        _credit(agent, bond - forfeit);
        _releaseClaim(t);

        bool reopen = block.timestamp < t.openUntil;
        t.status = reopen ? Status.Open : Status.Settled;
        t.agent = address(0);
        t.runner = address(0);
        t.bond = 0;
        t.claimDeadline = 0;
        emit ExitRecorded(id, Outcome.O5);
        emit ClaimTimedOut(id, agent, forfeit, reopen);

        if (!reopen) {
            uint256 amount = uint256(t.reward) + t.fee;
            t.outcome = Outcome.O6;
            t.paidOut += amount;
            _credit(t.sponsor, amount);
            emit Settled(id, Outcome.O6, 0, amount, 0);
        }
    }

    // ───────────────────────── stage III — Harena ─────────────
    /// @notice Reveal the sealed holdout against its commitment: sha256(salt ‖ digest) must
    /// equal what was posted. Only the sponsor, or an attestor that ran it, may reveal.
    function revealHoldout(uint256 id, bytes32 holdoutDigest, bytes32 salt) external {
        Trial storage t = _trials[id];
        if (t.status != Status.Submitted) revert BadState();
        if (t.holdoutCommitment == bytes32(0)) revert HoldoutUnknown();
        if (msg.sender != t.sponsor && !isAttestor[msg.sender]) revert NotSponsor();
        if (t.holdoutRevealed) revert HoldoutAlreadyRevealed();
        if (block.timestamp > t.holdoutDueBy) revert HoldoutDeadlinePassed();
        if (sha256(abi.encodePacked(salt, holdoutDigest)) != t.holdoutCommitment) revert HoldoutCommitmentMismatch();
        t.holdoutRevealed = true;
        t.holdoutDigest = holdoutDigest;
        emit HoldoutRevealed(id, holdoutDigest);
    }

    /// @notice Submit a pass. The runner key and a registered attestor must both have signed
    /// the same digests, the attestation must say `passed`, and the nonce must advance
    /// (gates 737, 738). A suite that is red cannot be submitted at all, by either signer.
    function submitRun(
        uint256 id,
        bytes32 artifactDigest,
        bytes32 verdictHash,
        bytes32 replayHash,
        bytes32 modelHarnessId,
        uint64 nonce,
        uint64 sigDeadline,
        bytes calldata runnerSig,
        bytes calldata attestorSig
    ) external notReentrant {
        Trial storage t = _trials[id];
        if (t.status != Status.Claimed) revert BadState();
        if (block.timestamp >= t.claimDeadline) revert BadDeadline();
        if (sigDeadline <= block.timestamp) revert SigExpired();
        if (t.runner == address(0)) revert NoRunner();
        if (artifactDigest == bytes32(0) || verdictHash == bytes32(0) || replayHash == bytes32(0)) {
            revert DigestMismatch();
        }

        bytes32 trialWord = bytes32(id);
        if (nonce <= _lastNonce[t.runner]) revert NonceReplayed();

        bytes32 runDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN,
                keccak256(
                    abi.encode(
                        RUN_TYPEHASH,
                        trialWord,
                        t.agent,
                        artifactDigest,
                        verdictHash,
                        replayHash,
                        modelHarnessId,
                        nonce,
                        sigDeadline
                    )
                )
            )
        );
        address signer =
            t.runner.code.length == 0 ? _recover(runDigest, runnerSig) : _walletSigner(runDigest, runnerSig, t.runner);
        if (signer != t.runner) revert BadSigner();

        bytes32 attestDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN,
                keccak256(
                    abi.encode(ATTEST_TYPEHASH, trialWord, artifactDigest, verdictHash, replayHash, true, sigDeadline)
                )
            )
        );
        address attestor = _recover(attestDigest, attestorSig);
        if (!isAttestor[attestor]) revert BadSigner();

        // Checks above, effects here, and there is no interaction after: the two verifications
        // are pure ecrecover, and the only external call in this function is a staticcall into
        // an ERC-1271 wallet that has already been checked against the runner key we trust.
        _lastNonce[t.runner] = nonce;
        t.status = Status.Submitted;
        t.runHash = artifactDigest;
        t.verdictHash = verdictHash;
        t.replayHash = replayHash;
        t.modelHarnessId = modelHarnessId;
        t.submittedAt = uint40(block.timestamp);
        t.windowEnd = uint40(block.timestamp + t.skepticWindow);
        t.holdoutDueBy = uint40(block.timestamp + Params.holdoutRevealMax(t.skepticWindow));
        emit RunSubmitted(id, t.agent, artifactDigest, verdictHash, replayHash);
    }

    // ───────────────────────── stage IV — Provocatio ──────────
    /// @notice Commit a sealed break: escrow S + A together, where A is this break's seat-fee
    /// pool. The commitment hides the payload until the window closes, so nobody can copy the
    /// discoverer (T5, gate 741). The agent that made the claim may not file against itself.
    function commitBreak(uint256 id, bytes32 commitment) external payable {
        Trial storage t = _trials[id];
        if (t.status != Status.Submitted) revert BadState();
        if (block.timestamp >= t.windowEnd) revert WindowStillOpen();
        if (msg.sender == t.agent) revert SelfBreak();
        if (commitment == bytes32(0)) revert TooSmall();
        if (_breaks[id].length >= MAX_FILING) revert TooManyBreaks();

        uint256 stakeMin = (uint256(t.reward) * Params.SKEPTIC_STAKE_MIN_BPS) / BPS;
        uint256 seatFee = (uint256(t.reward) * Params.SEAT_FEE_BPS) / BPS * Params.ARGUS_SEATS;
        if (msg.value < stakeMin) revert StakeTooSmall();
        if (msg.value < stakeMin + seatFee) revert SeatFeeWrong();
        // Everything above the floor stake is stake; A is exact, because the seats are paid a
        // share of it and a deposit that could not cover three shares is a broken filing.
        uint256 stake = msg.value - seatFee;

        Break storage b = _breaks[id].push();
        b.skeptic = msg.sender;
        b.commitment = commitment;
        b.stake = uint128(stake);
        b.seatFee = uint64(seatFee);
        b.committedAt = uint40(block.timestamp);
        t.deposited += msg.value;
        totalDeposited += msg.value;
        emit BreakCommitted(id, _breaks[id].length - 1, msg.sender, stake, seatFee);
    }

    /// @notice Open the seal, after the window and inside the grace.
    function revealBreak(uint256 id, uint256 index, BreakKind kind, bytes32 evidence, bytes32 salt) external {
        Trial storage t = _trials[id];
        if (t.status != Status.Submitted) revert BadState();
        if (block.timestamp < t.windowEnd) revert WindowStillOpen();
        if (block.timestamp > t.windowEnd + Params.BREAK_REVEAL_GRACE_SECONDS) revert RevealWindowClosed();
        Break storage b = _breakAt(id, index);
        if (b.revealed) revert AlreadyRevealed();
        if (
            sha256(abi.encodePacked("CRUCIBLE:break:v1", bytes32(id), b.skeptic, uint8(kind), evidence, salt))
                != b.commitment
        ) revert CommitMismatch();
        b.revealed = true;
        b.kind = kind;
        b.evidence = evidence;
        emit BreakRevealed(id, index, uint8(kind), evidence);
    }

    /// @notice Rank the revealed breaks — highest stake first, ties to the earlier commit —
    /// keep the top MAX_DOCKET, refund everyone else in full, and settle O1 if nothing was
    /// revealed at all (gates 739, 742).
    function freezeDocket(uint256 id) external {
        Trial storage t = _trials[id];
        // The flag is checked first so the error names the real reason. Behind the state check
        // it was unreachable decoration: a second crank always looked "wrong state" first.
        if (t.docketFrozen) revert DocketAlreadyFrozen();
        if (t.status != Status.Submitted) revert BadState();
        if (block.timestamp < t.windowEnd + Params.BREAK_REVEAL_GRACE_SECONDS) revert RevealWindowClosed();
        t.docketFrozen = true;

        if (!t.holdoutRevealed && block.timestamp > t.holdoutDueBy) {
            t.holdoutMissed = true;
            emit HoldoutMissed(id);
        }

        Break[] storage list = _breaks[id];
        uint256 n = list.length;
        uint256 revealedCount;
        for (uint256 i; i < n; ++i) {
            if (list[i].revealed) revealedCount++;
        }

        if (revealedCount == 0) {
            t.status = Status.Settled;
            _settleNoBreak(id);
            return;
        }

        uint256 keep = revealedCount < Params.MAX_DOCKET ? revealedCount : Params.MAX_DOCKET;
        for (uint256 k; k < keep; ++k) {
            uint256 best = type(uint256).max;
            for (uint256 i; i < n; ++i) {
                Break storage cand = list[i];
                if (!cand.revealed || cand.onDocket) continue;
                if (best == type(uint256).max) {
                    best = i;
                    continue;
                }
                Break storage cur = list[best];
                // Stake descends first; an identical stake is broken by the earlier commit, so
                // racing an alt with the same number buys nothing.
                if (cand.stake > cur.stake || (cand.stake == cur.stake && cand.committedAt < cur.committedAt)) {
                    best = i;
                }
            }
            if (best == type(uint256).max) break;
            list[best].onDocket = true;
        }

        for (uint256 i; i < n; ++i) {
            Break storage b = list[i];
            if (b.revealed && !b.onDocket && !b.settled) {
                b.settled = true;
                t.paidOut += uint256(b.stake) + b.seatFee;
                _credit(b.skeptic, uint256(b.stake) + b.seatFee);
            }
        }
        t.status = Status.Docketed;
        t.round = 1;
        emit DocketFrozen(id, keep);
    }

    // ───────────────────────── stage V — Sententia ────────────
    /// @notice Draw ARGUS_SEATS bonded, unconflicted seats for this trial and round.
    /// Permissionless; retries are free, and if no eligible pool exists the draw simply fails
    /// and the docket waits for O8's exit (G10, G11).
    function drawPanel(uint256 id, uint8 round) external {
        Trial storage t = _trials[id];
        if (t.status != Status.Docketed) revert BadState();
        // `t.round` is the panel this trial owes: 1 when the docket froze, 2 after a hung
        // tally. Asking for any other round is a stale or greedy caller, not a second jury.
        if (round != t.round) revert RoundTooLate();
        if (_panels[id][round].seatCount != 0) revert PanelAlreadyDrawn();
        if (randomnessMode == 1) revert RandomnessNotConfigured();

        uint256 seed = uint256(keccak256(abi.encodePacked(block.prevrandao, block.number, id, round)));
        address[3] memory picked = court.draw(seed, _exclusions(id, round), _seatBondFloor(t));
        if (picked[0] == address(0) || picked[1] == address(0) || picked[2] == address(0)) revert BadDraw();

        Panel storage p = _panels[id][round];
        p.seats = picked;
        p.seatCount = 3;
        p.drawnAt = uint40(block.timestamp);
        t.round = round;
        t.status = Status.Panel;
        // Lock the seats to this panel before anyone can vote on it: a seat that could unbond
        // mid-dispute could walk away from a no-show slash, which is the whole deterrent.
        court.noteDraw(picked);
        emit PanelDrawn(id, round, picked[0], picked[1], picked[2], true);
    }

    /// @notice Commit the whole ballot at once: one byte per docket entry plus the replay hash
    /// this seat observed. A seat that misses this window is slashed, not merely silent.
    function commitVote(uint256 id, bytes32 commitment) external {
        Trial storage t = _trials[id];
        if (t.status != Status.Panel) revert BadState();
        Panel storage p = _panels[id][t.round];
        if (p.seatCount != 3) revert PanelNotDrawn();
        if (block.timestamp > p.drawnAt + Params.VOTE_COMMIT_WINDOW_SECONDS) revert CommitClosed();
        // Only a seat on this panel may open a ballot. Without this, any address could fill the
        // commitment mapping for a jury it is not on: harmless to the money, but it is a
        // permissionless way to grow another party's storage, and the ballot is not theirs.
        if (!_isPanelSeat(p, msg.sender)) revert NotSeat();
        if (_voteCommit[id][t.round][msg.sender] != bytes32(0)) revert AlreadyCommitted();
        if (commitment == bytes32(0)) revert TooSmall();
        _voteCommit[id][t.round][msg.sender] = commitment;
        emit VoteCommitted(id, t.round, msg.sender);
    }

    /// @param votes one byte per docket entry, in docket order
    function revealVote(uint256 id, uint8 round, bytes calldata votes, bytes32 replayHash, bytes32 salt) external {
        Trial storage t = _trials[id];
        if (t.status != Status.Panel || round != t.round) revert BadState();
        Panel storage p = _panels[id][round];
        if (p.seatCount != 3) revert PanelNotDrawn();
        if (!_isPanelSeat(p, msg.sender)) revert NotSeat();
        if (_voteCommit[id][round][msg.sender] == bytes32(0)) revert CommitMismatch();
        if (_voteReveal[id][round][msg.sender].length != 0) revert AlreadyRevealedVote();

        // Late reveal: the seat is slashed and it earns nothing, exactly as a missed commit.
        if (block.timestamp > p.drawnAt + Params.VOTE_COMMIT_WINDOW_SECONDS + Params.VOTE_REVEAL_WINDOW_SECONDS) {
            if (!_slashed[id][round][msg.sender]) {
                _slashed[id][round][msg.sender] = true;
                court.slashNoShow(msg.sender, treasury);
                emit SeatSlashed(id, round, msg.sender);
            }
            _voteVoid[id][round][msg.sender] = true;
            return;
        }

        if (
            sha256(abi.encodePacked("CRUCIBLE:vote:v1", bytes32(id), round, msg.sender, votes, replayHash, salt))
                != _voteCommit[id][round][msg.sender]
        ) {
            revert CommitMismatch();
        }
        if (votes.length != _docketSize(id)) revert VoteLen();

        _voteReveal[id][round][msg.sender] = votes;
        // §6.4.2: a mechanical vote whose replay hash disagrees with the attested replay is
        // void. Only if this ballot actually contains a mechanical call — abstaining on the
        // interpretive rows with a stale hash is not a lie about a measurement.
        if (replayHash != t.replayHash && _hasMechanical(votes)) _voteVoid[id][round][msg.sender] = true;
        emit VoteRevealed(id, round, msg.sender, keccak256(votes));
    }

    /// @notice Per break: 2 Upheld lands it, 2 Rejected fails it, anything else is unresolved.
    /// Unresolved in round 1 redraws with fresh seats; still unresolved at MAX_ARGUS_ROUNDS,
    /// everybody is refunded (O8), so no trial can strand funds (G11, gate 746).
    function tally(uint256 id) external {
        Trial storage t = _trials[id];
        if (t.status != Status.Panel) revert BadState();
        Panel storage p = _panels[id][t.round];
        if (block.timestamp <= p.drawnAt + Params.VOTE_COMMIT_WINDOW_SECONDS + Params.VOTE_REVEAL_WINDOW_SECONDS) {
            revert TallyOpen();
        }

        for (uint8 s; s < 3; ++s) {
            address seat = p.seats[s];
            if (_voteCommit[id][t.round][seat] == bytes32(0)) {
                if (!_slashed[id][t.round][seat]) {
                    _slashed[id][t.round][seat] = true;
                    court.slashNoShow(seat, treasury);
                    emit SeatSlashed(id, t.round, seat);
                }
                _voteVoid[id][t.round][seat] = true;
            }
        }

        Break[] storage list = _breaks[id];
        uint256 landed;
        uint256 unresolved;
        for (uint256 i; i < list.length; ++i) {
            Break storage b = list[i];
            // A break a previous panel already settled keeps its verdict and its deciding
            // round. Re-counting it with an empty round-2 ballot would turn a finished row
            // into an unresolved one and strand the whole trial into O8.
            if (!b.onDocket || b.decided) {
                if (b.landed) landed++;
                continue;
            }
            uint8 upheld;
            uint8 rejected;
            for (uint8 s; s < 3; ++s) {
                address seat = p.seats[s];
                if (_voteVoid[id][t.round][seat]) continue;
                bytes storage v = _voteReveal[id][t.round][seat];
                if (v.length == 0 || i >= v.length) continue;
                uint8 mark = uint8(v[i]);
                if (mark == uint8(Vote.Upheld)) upheld++;
                else if (mark == uint8(Vote.Rejected)) rejected++;
            }
            if (upheld >= Params.ARGUS_QUORUM) {
                b.decided = true;
                b.landed = true;
                b.decidedRound = t.round;
                landed++;
            } else if (rejected >= Params.ARGUS_QUORUM) {
                b.decided = true;
                b.decidedRound = t.round;
            } else {
                unresolved++;
            }
            emit BreakTallied(id, t.round, i, upheld, rejected, b.landed);
        }

        // This panel is finished with, one way or another; the seats may unbond again.
        court.closeDraw(p.seats);

        if (unresolved > 0 && t.round < Params.MAX_ARGUS_ROUNDS) {
            t.status = Status.Docketed; // round 2 draws fresh seats over the same docket
            t.round = uint8(t.round + 1);
            return;
        }
        t.status = Status.Settled;
        // Anything still unresolved at the round cap sends the whole trial to O8: no agent is
        // punished by a panel that could not reach a verdict, even a panel that settled some of
        // the other rows. That reading of §6.4.5 is recorded in DECISIONS.md.
        if (unresolved > 0) _settleNoQuorum(id);
        else if (landed > 0) _settleLanded(id);
        else _settleAllFailed(id);
    }

    // ───────────────────────── settlement ─────────────────────
    /// @dev O1 — nothing was revealed. Agent takes R + B; treasury takes F plus every
    /// unrevealed stake; each blind commit gets its seat fee back, since no panel worked on it.
    function _settleNoBreak(uint256 id) internal {
        Trial storage t = _trials[id];
        t.outcome = Outcome.O1;
        uint256 agentAmount = uint256(t.reward) + t.bond;
        t.paidOut += agentAmount + t.fee;
        _credit(t.agent, agentAmount);
        _credit(treasury, t.fee);
        _releaseClaim(t);

        Break[] storage list = _breaks[id];
        for (uint256 i; i < list.length; ++i) {
            Break storage b = list[i];
            if (b.revealed || b.settled) continue;
            b.settled = true;
            t.paidOut += uint256(b.stake) + b.seatFee;
            _credit(treasury, b.stake);
            _credit(b.skeptic, b.seatFee);
        }
        t.bond = 0;
        emit Settled(id, Outcome.O1, agentAmount, 0, t.fee);
    }

    /// @dev O2 — every docket break failed. Agent keeps R + B. A failed skeptic loses S to
    /// the treasury, and its A is what the seats that sat through it are paid from.
    function _settleAllFailed(uint256 id) internal {
        Trial storage t = _trials[id];
        t.outcome = Outcome.O2;
        uint256 agentAmount = uint256(t.reward) + t.bond;
        t.paidOut += agentAmount + t.fee;
        _credit(t.agent, agentAmount);
        _credit(treasury, t.fee);
        _releaseClaim(t);

        Break[] storage list = _breaks[id];
        for (uint256 i; i < list.length; ++i) {
            Break storage b = list[i];
            if (!b.onDocket || b.settled) continue;
            b.settled = true;
            t.paidOut += uint256(b.stake) + b.seatFee;
            _credit(treasury, b.stake);
            _paySeats(id, i, b.seatFee, false, b.decidedRound);
        }
        t.bond = 0;
        emit Settled(id, Outcome.O2, agentAmount, 0, t.fee);
    }

    /// @dev O3 — something landed. Sponsor is made whole including the fee (the claim did not
    /// survive), the agent forfeits the bond: BREAK_PRIZE_BPS to the earliest-landing skeptic,
    /// each landed break's seat pool out of the same bond, and every remainder to the treasury.
    function _settleLanded(uint256 id) internal {
        Trial storage t = _trials[id];
        t.outcome = Outcome.O3;
        uint256 bond = t.bond;
        uint256 prize = (bond * Params.BREAK_PRIZE_BPS) / BPS;

        t.paidOut += uint256(t.reward) + t.fee;
        _credit(t.sponsor, uint256(t.reward) + t.fee);
        _releaseClaim(t);

        Break[] storage list = _breaks[id];
        uint256 drawnFromBond = prize;
        bool prizeGiven;
        for (uint256 i; i < list.length; ++i) {
            Break storage b = list[i];
            if (!b.onDocket || b.settled) continue;
            b.settled = true;
            t.paidOut += uint256(b.stake) + b.seatFee;
            if (b.landed) {
                // The prize follows the earliest commit that landed, not the biggest stake.
                if (!prizeGiven) {
                    prizeGiven = true;
                    _credit(b.skeptic, uint256(b.stake) + b.seatFee + prize);
                } else {
                    _credit(b.skeptic, uint256(b.stake) + b.seatFee);
                }
                drawnFromBond += _paySeats(id, i, b.seatFee, true, b.decidedRound);
            } else {
                _credit(treasury, b.stake);
                drawnFromBond += _paySeats(id, i, b.seatFee, false, b.decidedRound);
            }
        }
        // Params invariant 1 promises MAX_DOCKET seat pools fit inside the unprized bond. If a
        // parameter set ever breaks that, the arena refuses to settle rather than pay money it
        // does not hold out of a stranger's escrow.
        if (drawnFromBond > bond) revert BondShortfall();
        uint256 treasuryShare = bond - drawnFromBond;
        // The bond leaves this trial in three pieces — prize, landed seat pools, remainder — and
        // the ledger counts it once, whole, so `paidOut == deposited` stays a meaningful check.
        t.paidOut += bond;
        _credit(treasury, treasuryShare);
        t.bond = 0;
        emit Settled(id, Outcome.O3, 0, uint256(t.reward) + t.fee, treasuryShare);
    }

    /// @dev O8 — two panels, no quorum. Everyone gets everything back; a no-show is still
    /// slashed and no seat is paid a fee for a verdict it did not reach.
    function _settleNoQuorum(uint256 id) internal {
        Trial storage t = _trials[id];
        t.outcome = Outcome.O8;
        uint256 sponsorAmount = uint256(t.reward) + t.fee;
        uint256 agentAmount = t.bond;
        t.paidOut += sponsorAmount + agentAmount;
        _credit(t.sponsor, sponsorAmount);
        _credit(t.agent, agentAmount);
        _releaseClaim(t);

        Break[] storage list = _breaks[id];
        for (uint256 i; i < list.length; ++i) {
            Break storage b = list[i];
            if (b.settled || !b.revealed) continue;
            b.settled = true;
            t.paidOut += uint256(b.stake) + b.seatFee;
            _credit(b.skeptic, uint256(b.stake) + b.seatFee);
        }
        t.bond = 0;
        emit Settled(id, Outcome.O8, agentAmount, sponsorAmount, 0);
    }

    /// @dev Split one break's seat pool into ARGUS_SEATS shares. Coherent seats — the ones that
    /// voted with the outcome and were not voided — take theirs; a void, absent or dissenting
    /// seat's share is unearned and falls to the treasury, along with the floor remainder.
    /// Returns the wei this drew out of the agent's bond (a landed break's pool comes from the
    /// bond, a failed break's comes from the losing skeptic's own deposit).
    function _paySeats(uint256 id, uint256 breakIndex, uint64 poolAmount, bool landed, uint8 atRound)
        internal
        returns (uint256 fromBond)
    {
        Panel storage p = _panels[id][atRound];
        uint256 share = poolAmount / Params.ARGUS_SEATS;
        uint256 paid;
        for (uint8 s; s < 3; ++s) {
            address seat = p.seats[s];
            if (seat == address(0)) continue;
            if (_seatCoherent(id, atRound, seat, breakIndex, landed)) _credit(seat, share);
            else _credit(treasury, share);
            paid += share;
        }
        uint256 remainder = poolAmount - paid;
        if (remainder > 0) _credit(treasury, remainder);
        if (landed) return poolAmount;
        return 0;
    }

    function _isPanelSeat(Panel storage p, address who) internal view returns (bool) {
        return p.seats[0] == who || p.seats[1] == who || p.seats[2] == who;
    }

    function _seatCoherent(uint256 id, uint8 round, address seat, uint256 breakIndex, bool landed)
        internal
        view
        returns (bool)
    {
        if (_voteVoid[id][round][seat]) return false;
        bytes storage v = _voteReveal[id][round][seat];
        if (v.length == 0 || breakIndex >= v.length) return false;
        return uint8(v[breakIndex]) == (landed ? uint8(Vote.Upheld) : uint8(Vote.Rejected));
    }

    /// @dev One place where an agent's in-flight claim is released, so the anti-squatting
    /// counter cannot leak upward and lock someone out of the arena forever.
    function _releaseClaim(Trial storage t) internal {
        if (!t.activeCounted) return;
        t.activeCounted = false;
        address agent = t.agent;
        if (agent != address(0) && activeClaimsOf[agent] > 0) activeClaimsOf[agent] -= 1;
    }

    // ───────────────────────── pull payments ──────────────────
    function _credit(address to, uint256 amount) internal {
        if (amount == 0) return;
        credit[to] += amount;
        totalPending += amount;
        emit Credited(to, amount);
    }

    /// @notice The only ETH exit, and the only `{value:}` site (ADR-0003).
    function withdraw() external notReentrant {
        uint256 amt = credit[msg.sender];
        if (amt == 0) revert NothingToWithdraw();
        credit[msg.sender] = 0;
        totalPending -= amt;
        withdrawn[msg.sender] += amt;
        totalWithdrawn += amt;
        (bool ok,) = msg.sender.call{value: amt}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amt);
    }

    // ───────────────────────── views ──────────────────────────
    // Returned a field group at a time on purpose: the legacy escrow learned that a struct
    // this wide, returned by memory, is what puts solc back over the stack ceiling.
    //
    // The scalars below are the same storage read one field at a time. A reader that wants one
    // number — the countdown on a trial page, the keeper's readiness check — should not have to
    // take seven and name six of them, which is how a mis-ordered destructuring becomes a
    // wrong deadline on a live screen.

    function stateOf(uint256 id)
        external
        view
        returns (
            Status status,
            Outcome outcome,
            uint8 round,
            bool docketFrozen,
            bool holdoutRevealed,
            bool holdoutMissed
        )
    {
        Trial storage t = _trials[id];
        return (t.status, t.outcome, t.round, t.docketFrozen, t.holdoutRevealed, t.holdoutMissed);
    }

    function amountsOf(uint256 id)
        external
        view
        returns (uint256 reward, uint256 fee, uint256 bond, uint256 deposited, uint256 paidOut)
    {
        Trial storage t = _trials[id];
        return (t.reward, t.fee, t.bond, t.deposited, t.paidOut);
    }

    function windowsOf(uint256 id)
        external
        view
        returns (
            uint256 openedAt,
            uint256 openUntil,
            uint256 claimDeadline,
            uint256 submittedAt,
            uint256 windowEnd,
            uint256 holdoutDueBy,
            uint32 skepticWindow
        )
    {
        Trial storage t = _trials[id];
        return (t.openedAt, t.openUntil, t.claimDeadline, t.submittedAt, t.windowEnd, t.holdoutDueBy, t.skepticWindow);
    }

    function partiesOf(uint256 id) external view returns (address sponsor, address agent, address runner) {
        Trial storage t = _trials[id];
        return (t.sponsor, t.agent, t.runner);
    }

    /// @notice How many trials have been posted; ids run `1..trialCount()`.
    /// @dev `_nextId` is private, so a keeper or a reader that wants to walk the arena would
    /// otherwise have to scan `TrialPosted` from genesis on every tick. One accessor answers it
    /// for both, and it is cheaper than the log scan it replaces.
    function trialCount() external view returns (uint256) {
        return _nextId - 1;
    }

    function digestsOf(uint256 id)
        external
        view
        returns (
            bytes32 specDigest,
            bytes32 suiteDigest,
            bytes32 holdoutCommitment,
            bytes32 holdoutDigest,
            bytes32 runHash,
            bytes32 verdictHash,
            bytes32 replayHash,
            bytes32 modelHarnessId
        )
    {
        Trial storage t = _trials[id];
        return (
            t.specDigest,
            t.suiteDigest,
            t.holdoutCommitment,
            t.holdoutDigest,
            t.runHash,
            t.verdictHash,
            t.replayHash,
            t.modelHarnessId
        );
    }

    function breakAt(uint256 id, uint256 index)
        external
        view
        returns (
            address skeptic,
            uint256 stake,
            uint256 seatFee,
            bool revealed,
            bool onDocket,
            bool landed,
            uint8 kind,
            uint256 committedAt
        )
    {
        Break storage b = _breakAt(id, index);
        return (b.skeptic, b.stake, b.seatFee, b.revealed, b.onDocket, b.landed, uint8(b.kind), b.committedAt);
    }

    function breakCount(uint256 id) external view returns (uint256) {
        return _breaks[id].length;
    }

    function docketSize(uint256 id) external view returns (uint256) {
        return _docketSize(id);
    }

    function panelSeats(uint256 id, uint8 round) external view returns (address, address, address) {
        Panel storage p = _panels[id][round];
        return (p.seats[0], p.seats[1], p.seats[2]);
    }

    function panelDrawnAt(uint256 id, uint8 round) external view returns (uint256) {
        return _panels[id][round].drawnAt;
    }

    function voteOf(uint256 id, uint8 round, address seat) external view returns (bytes memory) {
        return _voteReveal[id][round][seat];
    }

    function voteVoided(uint256 id, uint8 round, address seat) external view returns (bool) {
        return _voteVoid[id][round][seat];
    }

    function seatFeePerBreak(uint256 id) external view returns (uint256) {
        return (uint256(_trials[id].reward) * Params.SEAT_FEE_BPS) / BPS * Params.ARGUS_SEATS;
    }

    function minimumStake(uint256 id) external view returns (uint256) {
        return (uint256(_trials[id].reward) * Params.SKEPTIC_STAKE_MIN_BPS) / BPS;
    }

    /// @notice The free bond a seat needs before this trial's panel can draw it.
    /// @dev `court.isEligible(seat, minBond)` takes the number as an argument, so without this a
    /// seat operator has no way to ask the arena how much it must post before bonding — it could
    /// only discover the answer by failing a draw someone else paid for. Same expression the draw
    /// screens with, so the two cannot drift.
    function seatBondFloor(uint256 id) external view returns (uint256) {
        return _seatBondFloor(_trials[id]);
    }

    /// @notice Ghost-ledger identity (gate 744), the bible's own form: what every vault ever
    /// took in equals what has left it plus what it still holds.
    function conservationHolds() external view returns (bool) {
        return address(this).balance + totalWithdrawn == totalDeposited;
    }

    /// @dev The same identity, stated as two comparisons a handler can check independently: the
    /// books never promise more ETH than the contract holds, and every wei in is accounted for.
    function conservationDetail() external view returns (bool balanceOk, bool booksOk) {
        balanceOk = address(this).balance >= totalPending;
        booksOk = address(this).balance + totalWithdrawn == totalDeposited;
    }

    // ───────────────────────── internals ──────────────────────
    function _breakAt(uint256 id, uint256 index) internal view returns (Break storage b) {
        if (index >= _breaks[id].length) revert BreakUnknown();
        b = _breaks[id][index];
    }

    function _docketSize(uint256 id) internal view returns (uint256 n) {
        Break[] storage list = _breaks[id];
        for (uint256 i; i < list.length; ++i) {
            if (list[i].onDocket) n++;
        }
    }

    function _hasMechanical(bytes calldata votes) internal pure returns (bool) {
        for (uint256 i; i < votes.length; ++i) {
            uint8 mark = uint8(votes[i]);
            if (mark == uint8(Vote.Upheld) || mark == uint8(Vote.Rejected)) return true;
        }
        return false;
    }

    /// @dev Who may not sit: the sponsor, the agent, every docket skeptic, and — from round 2
    /// on — the round-1 seats, so a hung jury cannot be re-run in front of the same jury.
    function _exclusions(uint256 id, uint8 round) internal view returns (address[] memory list) {
        Trial storage t = _trials[id];
        Break[] storage brk = _breaks[id];
        uint256 docket = _docketSize(id);
        uint256 size = 2 + docket + (round > 1 ? 3 : 0);
        list = new address[](size);
        uint256 k;
        list[k++] = t.sponsor;
        list[k++] = t.agent;
        for (uint256 i; i < brk.length && k < size; ++i) {
            if (brk[i].onDocket) list[k++] = brk[i].skeptic;
        }
        if (round > 1) {
            Panel storage first = _panels[id][1];
            for (uint8 s; s < 3 && k < size; ++s) {
                list[k++] = first.seats[s];
            }
        }
    }

    /// @dev A seat must be able to lose what it could earn here five times over: its own share
    /// per break × the most breaks it could ever sit × SEAT_BOND_MIN_MULTIPLE.
    function _seatBondFloor(Trial storage t) internal view returns (uint256) {
        uint256 perSeatPerBreak = (uint256(t.reward) * Params.SEAT_FEE_BPS) / BPS;
        return perSeatPerBreak * Params.MAX_DOCKET * Params.SEAT_BOND_MIN_MULTIPLE;
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert BadSigLength();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v != 27 && v != 28) revert BadSigLength();
        if (uint256(s) > _SECP256K1_HALF_N) revert SigMalleable();
        return ecrecover(digest, v, r, s);
    }

    /// @notice ERC-1271: a smart-account runner may sign for itself. The address consulted is
    /// always the runner this claim already trusts, so this widens what a signer may be, never
    /// who may act. A wallet that returns anything but the magic value is a BadSigner.
    function _walletSigner(bytes32 digest, bytes calldata sig, address expected) internal view returns (address) {
        try IERC1271(expected).isValidSignature(digest, sig) returns (bytes4 magic) {
            if (magic == IERC1271.isValidSignature.selector) return expected;
        } catch {
            revert BadSigner();
        }
        revert BadSigner();
    }
}

interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4);
}

interface ArgusCourtPublic {
    /// @dev `view`, not `payable`: the draw is a selection over bonded seats and moves nothing.
    function draw(uint256 seed, address[] calldata exclusions, uint256 minBond)
        external
        view
        returns (address[3] memory picked);
    function noteDraw(address[3] calldata seats) external;
    function closeDraw(address[3] calldata seats) external;
    function slashNoShow(address seat, address treasury) external;
}
