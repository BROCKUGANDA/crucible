// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReputationBridge} from "./ReputationBridge.sol";

/// @notice The one read CrucibleTrials needs from an ERC-8004 Identity Registry: who a
/// tokenId belongs to. Declared locally, like the other external interfaces here, so the
/// contracts build with no external dependency.
interface IIdentityOwnership {
    function ownerOf(uint256 agentId) external view returns (address);
}

/// @notice Reputation sink implemented by AlloyRegistry. Only CrucibleTrials may write.
interface IAlloyRegistry {
    function recordWin(uint256 agentId, address operator, bool survivedBreak) external;
    function recordSlash(uint256 agentId, address operator) external;
}

/// @title CrucibleTrials
/// @notice Escrow + state machine for bountied, adversarially-verified agent trials.
/// State machine: Open -> Assigned -> Judging -> Challenged -> Settled
///                                   |-> Settled (window expired, no break)
/// Assigned -> Settled (Refunded) is possible via reclaimExpired (no run by deadline).
/// All payouts use a pull ledger (`credit` + `withdraw`); the contract never pushes ETH.
contract CrucibleTrials {
    // ───────────────────────── errors ─────────────────────────
    error ZeroTreasury();
    error ZeroIdentity();
    error IdentityNotOwned();
    error RewardTooSmall();
    error BadWindow();
    error BadDeadline();
    error StakeTooSmall();
    error AlreadyRegistered();
    error NotAnAgent();
    error NotOpen();
    error NotAssigned();
    error NotJudging();
    error NotChallenged();
    error SelfBreak();
    error NotFinalizable();
    error NotReclaimable();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error WindowOpen();
    error WindowClosed();
    error AlreadySettled();
    error DisputeUnresolved();
    error BadSigner();
    error BadSig();
    error SigExpired();
    error SigMalleable();
    error NotOperator();
    error NotArgus();
    error CommitMismatch();
    error AlreadyCommitted();
    error AlreadyRevealed();
    error CommitClosed();
    error NothingToWithdraw();
    error TransferFailed();
    error NotOwner();
    error BadArgusSeatCount();
    error DuplicateArgusSeat();
    error ZeroArgusSeat();

    // ───────────────────────── types ──────────────────────────
    enum Status {
        Open,
        Assigned,
        Judging,
        Challenged,
        Settled
    }
    enum Verdict {
        None,
        Paid,
        Slashed,
        Refunded
    }

    /// The four timestamps are packed into one slot rather than stored as four
    /// uint64 fields. This is not only gas: a 16-field struct exceeds the 16-slot
    /// stack when ABI-encoded as a return value, which breaks `forge coverage`
    /// (it disables the optimizer) under solc's legacy codegen. 13 words is under.
    /// Read them with createdAtOf/… helpers — never index the raw word.
    struct Trial {
        address sponsor;
        bytes32 specCID; // IPFS CID of the trial spec (pinned)
        bytes32 testsCID; // IPFS CID of the pinned test suite
        uint128 reward; // escrowed by sponsor
        uint128 bond; // staked by agent at claim = bondFor(reward)
        uint256 timestamps; // createdAt | deadline<<64 | breakWindow<<128 | runAt<<192
        uint96 agentId;
        bytes32 runHash; // keccak256(JCS(RunArtifact))
        bytes32 breakProofCID; // skeptic evidence
        address breakSkeptic;
        uint128 breakStake;
        Status status;
        Verdict verdict;
    }

    struct Agent {
        address operator;
        address runner; // key that signs RunArtifacts (EIP-712)
        string metadataURI; // capabilities manifest (ERC-8004 style)
        uint128 stake; // FREE stake balance (bonds move to escrow at claim)
        uint32 active; // trials currently held
    }

    struct Dispute {
        uint64 openedAt; // set at fileBreak
        bool revealStarted;
        uint8 votesBreak;
        uint8 votesAgent;
        mapping(address => bytes32) commits;
        mapping(address => bool) revealed;
    }

    // ───────────────────────── constants ──────────────────────
    uint256 public constant MIN_BOND = 0.01 ether;
    uint256 public constant BOND_NUM = 1;
    uint256 public constant BOND_DEN = 5; // bond = 20% of reward, floor MIN_BOND
    uint256 public constant BREAK_STAKE_DEN = 100; // break stake >= 1% of reward
    uint256 public constant FEE_BPS = 500; // 5% settlement fee
    uint256 public constant BPS = 10_000;
    uint256 public constant SLASH_SKEPTIC_NUM = 3_000; // 30% of bond to a winning skeptic
    uint256 public constant MIN_RUN_WINDOW = 1 hours;
    uint256 public constant MIN_BREAK_WINDOW = 1 hours;
    uint256 public constant MAX_BREAK_WINDOW = 7 days;
    uint256 public constant DISPUTE_TIMEOUT = 3 days;

    /// @notice How long after a dispute opens an Argus seat may still seal a commitment.
    ///
    /// @dev Commits used to be closed by the first *reveal*. That let one seat decide every
    /// dispute by itself: seal a commitment, reveal it immediately, and the other two can
    /// never seal one — quorum becomes unreachable by construction, and the timeout settles
    /// in the agent's favour. A deadline closes commits on the clock instead of on somebody
    /// else's move. The cost, and it is real: a seat that sleeps past this window forfeits
    /// its vote even if nobody revealed, which it did not used to. Reveals stay open for the
    /// rest of DISPUTE_TIMEOUT, so a seat that sealed on time is never rushed.
    uint256 public constant COMMIT_WINDOW = 24 hours;

    /// @notice Argus votes needed to resolve a dispute, out of exactly `ARGUS_THRESHOLD + 1`
    /// seats — the seat count the constructor refuses to deploy any other way.
    /// @dev A `constant`, so changing the quorum is a recompile and a fresh deployment, not
    /// an owner call. `ARGUS_THRESHOLD + 1` is therefore the only seat set that is a majority
    /// of itself; validation below is pinned to this value rather than to a literal 3 so the
    /// two cannot drift apart inside one compilation.
    uint256 public constant ARGUS_THRESHOLD = 2; // 2-of-3 seats

    bytes32 public constant RUN_TYPEHASH =
        keccak256("Run(uint256 trialId,uint256 agentId,bytes32 runHash,uint64 sigDeadline)");
    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    // ───────────────────────── storage ────────────────────────
    address public immutable treasury;
    IAlloyRegistry public immutable alloy;
    bytes32 public immutable DOMAIN;

    /// @notice Optional ERC-8004 reputation sink. Zero means "not wired"; settlement
    /// then proceeds exactly as before, because a third-party registry being down must
    /// never be able to block a verdict.
    address public reputationBridge;

    /// @notice Optional ERC-8004 Identity Registry. Zero means "not wired". When set,
    /// an agent can link the identity registry attestation that they own it.
    address public identityRegistry;

    /// @notice Crucible agentId -> the ERC-8004 identity agentId that the operator
    /// registered for the same agent. Zero means "no identity linked", and is the value
    /// `ReputationBridge` reads to decide whether it may write at all.
    mapping(uint256 => uint256) public identityOf;

    uint256 public trialCount;
    uint256 public agentCount;
    uint256 public totalStakes; // Σ free agent stake balances
    uint256 public totalPending; // Σ credit ledger
    uint256 public escrowed; // Σ ETH locked in live trials (reward + bond + break stake)

    mapping(uint256 => Trial) public trials;
    mapping(uint256 => Agent) public agents;
    mapping(address => uint256) public agentIdOf; // operator -> agentId (0 = none)
    mapping(address => uint256) public credit; // pull ledger
    mapping(address => bool) public isArgus;
    mapping(uint256 => Dispute) private _disputes;

    uint256 private _guard;

    modifier nonReentrant() {
        if (_guard == 0) revert TransferFailed();
        _guard = 0;
        _;
        _guard = 1;
    }

    // ───────────────────────── events ─────────────────────────
    event TrialCreated(
        uint256 indexed id,
        address indexed sponsor,
        bytes32 specCID,
        bytes32 testsCID,
        uint256 reward,
        uint256 bond,
        uint64 deadline,
        uint64 breakWindow
    );
    event AgentRegistered(
        uint256 indexed agentId, address indexed operator, address runner, string metadataURI, uint256 stake
    );
    event RunnerSet(uint256 indexed agentId, address runner);
    event TrialClaimed(uint256 indexed id, uint256 indexed agentId, uint256 bond);
    event RunSubmitted(uint256 indexed id, uint256 indexed agentId, bytes32 runHash);
    event BreakFiled(uint256 indexed id, address indexed skeptic, bytes32 proofCID, uint256 stake);
    event DisputeOpened(uint256 indexed id);
    event VoteCommitted(uint256 indexed id, address indexed judge);
    event VoteRevealed(uint256 indexed id, address indexed judge, bool breakWins);
    event VerdictFinalized(uint256 indexed id, Verdict verdict, uint256 agentPayout);
    event StakeWithdrawn(uint256 indexed agentId, address indexed to, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event IdentityRegistrySet(address indexed registry);
    event IdentityLinked(uint256 indexed agentId, uint256 indexed identityAgentId);

    /// @param treasury_ fee + burned-slash recipient
    /// @param alloy_ reputation registry (setForge called right after deploy)
    /// @param argus_ exactly `ARGUS_THRESHOLD + 1` distinct, non-zero dispute seats
    /// (2-of-3 commit-reveal in v1)
    ///
    /// @dev The seat set is validated rather than trusted, because a jury that cannot reach
    /// quorum is invisible until it fails. Reproduced against deployed bytecode: deployed
    /// with one seat, that seat commits and reveals `breakWins = true`, `votesBreak == 1`
    /// never reaches the hard-coded threshold of 2, the dispute is never resolved on votes,
    /// and `finalize` at the timeout settles with `agentWins = true` — a jury that voted
    /// 100% to slash, paid the agent. Ten seats was the mirror case: a 2-of-10 quorum is a
    /// fifth of the jury, and the eight silent seats let the timeout override it.
    /// Both are now undeployable.
    constructor(address treasury_, address alloy_, address[] memory argus_) {
        // A zero treasury would route every protocol fee and every burned slash to an
        // address nobody controls — irrecoverably, since there is no setter.
        if (treasury_ == address(0)) revert ZeroTreasury();
        if (argus_.length != ARGUS_THRESHOLD + 1) revert BadArgusSeatCount();
        treasury = treasury_;
        alloy = IAlloyRegistry(alloy_);
        _setArgusSeats(argus_);
        owner = msg.sender;
        DOMAIN = _computeDomain();
        _guard = 1;
    }

    /// Split out of the constructor for the same reason `_computeDomain` is: the seat loop
    /// plus the immutable writes plus the domain hash overflow the 16-slot stack under solc's
    /// legacy codegen, which is also the configuration `forge coverage` forces.
    function _setArgusSeats(address[] memory argus_) private {
        for (uint256 i; i < argus_.length; ++i) {
            address seat = argus_[i];
            // A zero seat is a seat nobody holds: commits against it can never be made, so
            // it silently lowers the quorum the whole design depends on.
            if (seat == address(0)) revert ZeroArgusSeat();
            // Duplicates are not two votes, they are one key counted twice — and they also
            // shrink the pool of independent voters below the threshold. Comparison is
            // O(n²) over an array of exactly ARGUS_THRESHOLD + 1 elements; a mapping would
            // cost more than the invariant is worth here.
            for (uint256 j; j < i; ++j) {
                if (argus_[j] == seat) revert DuplicateArgusSeat();
            }
            isArgus[seat] = true;
        }
    }

    /// @notice Wire (or unwire) the ERC-8004 reputation bridge. Owner-only, callable
    /// after deploy because the registry address is a per-chain singleton that may not
    /// exist at the moment Crucible is deployed.
    ///
    /// @dev address(0) is a meaningful value here, not a mistake: it deliberately
    /// *unwires* the bridge. Slither flags the missing zero-check; keeping the behaviour
    /// is the point — an owner must be able to turn reputation off without a redeploy.
    function setReputationBridge(address bridge) external {
        if (msg.sender != owner) revert NotOwner();
        reputationBridge = bridge;
    }

    /// @notice Point at the Identity registry that issued `identityAgentId` tokens.
    /// Zero is allowed and meaningful: it deliberately unwires Identity too.
    function setIdentityRegistry(address registry) external {
        if (msg.sender != owner) revert NotOwner();
        identityRegistry = registry;
        emit IdentityRegistrySet(registry);
    }

    /**
     * Link this agent to its ERC-8004 identity.
     *
     * Crucible cannot mint the identity NFT itself, because ERC-8004's
     * `register(agentURI)` mints to `msg.sender`. The operator therefore registers the
     * agent's identity directly with the Identity Registry's `register(...)` and passes
     * the returned tokenId here. This function's job is to *record* that link, and the
     * record is load-bearing in two places: an indexer follows a Crucible agentId to a
     * resolvable on-chain identity, and `ReputationBridge` resolves it as the subject of
     * every ERC-8004 write. An agent that has not linked simply earns no on-chain
     * reputation signal — the bridge skips the write and emits `FeedbackSkipped` rather
     * than grading whichever unrelated agent holds that tokenId.
     *
     * When an Identity Registry is wired, the tokenId is checked against it: the caller
     * must own the identity they are pointing at.
     *
     * This check exists because the record became load-bearing. `ReputationBridge` writes
     * every ERC-8004 grade to whatever id this function records, so without it an operator
     * could link a *victim's* identity, then take a slash and have the negative feedback
     * land on the victim. That is not a self-inflicted misroute — it is a way to damage an
     * unrelated agent's reputation with no more effort than one transaction, and the
     * public `IdentityLinked` audit trail does not undo the harm, it only names the
     * attacker afterwards.
     *
     * When no registry is wired (`identityRegistry == address(0)`) there is nothing to ask,
     * and linking stays permitted: the wiring is per-chain plumbing the owner may
     * deliberately unwire, and refusing to link at all would make an unwired deployment
     * unable to publish identity for its whole uptime. The link is then unverifiable, which
     * is a property of that deployment, not of this function.
     */
    function linkIdentity(uint256 agentId, uint256 identityAgentId) external {
        if (agents[agentId].operator != msg.sender) revert NotOperator();
        if (identityAgentId == 0) revert ZeroIdentity();
        if (identityRegistry != address(0)) {
            // Deliberately not wrapped: a registry that reverts must block the link rather
            // than let an unverifiable one through, and unlike settlement this is not on a
            // path where availability outranks correctness — nothing is lost by retrying.
            if (IIdentityOwnership(identityRegistry).ownerOf(identityAgentId) != msg.sender) {
                revert IdentityNotOwned();
            }
        }
        identityOf[agentId] = identityAgentId;
        emit IdentityLinked(agentId, identityAgentId);
    }

    /// @dev Ownable-by-construction: the deployer is the only address that can wire
    /// external reputation plumbing, and it holds no funds and no trial authority.
    address public immutable owner;

    /// Split out of the constructor on purpose: `abi.encode` of five words plus two
    /// nested keccak256 calls overflows the 16-slot stack under the legacy codegen,
    /// which then breaks every external `new CrucibleTrials(...)` call site too.
    function _computeDomain() internal view returns (bytes32) {
        return
            keccak256(abi.encode(_DOMAIN_TYPEHASH, keccak256("Crucible"), keccak256("1"), block.chainid, address(this)));
    }

    // ───────────────────────── sponsor ────────────────────────
    function createTrial(bytes32 specCID, bytes32 testsCID, uint64 deadline, uint64 breakWindow)
        external
        payable
        returns (uint256 id)
    {
        if (msg.value < MIN_BOND || msg.value > type(uint128).max) revert RewardTooSmall();
        if (deadline < block.timestamp + MIN_RUN_WINDOW) revert BadDeadline();
        if (breakWindow < MIN_BREAK_WINDOW || breakWindow > MAX_BREAK_WINDOW) revert BadWindow();
        id = ++trialCount;
        Trial storage t = trials[id];
        t.sponsor = msg.sender;
        t.specCID = specCID;
        t.testsCID = testsCID;
        t.reward = uint128(msg.value);
        t.bond = uint128(bondFor(msg.value));
        // createdAt | deadline<<64 | breakWindow<<128  (runAt stays 0 until submitRun)
        t.timestamps = uint256(block.timestamp) | (uint256(deadline) << 64) | (uint256(breakWindow) << 128);
        escrowed += msg.value;
        emit TrialCreated(id, msg.sender, specCID, testsCID, msg.value, t.bond, deadline, uint64(breakWindow));
    }

    // ── timestamp accessors (the packing is internal) ──
    function createdAtOf(uint256 id) public view returns (uint64) {
        return uint64(trials[id].timestamps);
    }

    function deadlineOf(uint256 id) public view returns (uint64) {
        return uint64(trials[id].timestamps >> 64);
    }

    function breakWindowOf(uint256 id) public view returns (uint64) {
        return uint64(trials[id].timestamps >> 128);
    }

    function runAtOf(uint256 id) public view returns (uint64) {
        return uint64(trials[id].timestamps >> 192);
    }

    function _setRunAt(uint256 id, uint64 ts) internal {
        // mask keeps bits 0..191 (createdAt | deadline | breakWindow) and clears the top word
        trials[id].timestamps = (trials[id].timestamps & (type(uint256).max >> 64)) | (uint256(ts) << 192);
    }

    /// end of the skeptic window for a trial that has a submitted run: runAt + breakWindow
    function _windowEnd(Trial storage t) internal view returns (uint256) {
        return uint256(uint64(t.timestamps >> 192)) + uint256(uint64(t.timestamps >> 128));
    }

    /// @notice Sponsor reclaims reward if no agent delivered a run by deadline. Bond returns to agent.
    ///
    /// @dev `Open` is reclaimable as well as `Assigned`. An unclaimed trial has no bond and
    /// no agent, so only the reward comes back — but without this branch the money has no
    /// exit at all: `finalize` needs `Judging|Challenged`, `claimTrial` is welded shut at the
    /// deadline, and the reward sits in escrow forever. A sponsor that priced a trial too
    /// high to attract an agent loses the whole reward to its own optimism.
    function reclaimExpired(uint256 id) external {
        Trial storage t = trials[id];
        if (t.status != Status.Assigned && t.status != Status.Open) revert NotReclaimable();
        if (block.timestamp < uint256(uint64(t.timestamps >> 64))) revert DeadlineNotPassed();
        bool wasClaimed = t.status == Status.Assigned;
        t.status = Status.Settled;
        t.verdict = Verdict.Refunded;
        escrowed -= uint256(t.reward);
        credit[t.sponsor] += t.reward;
        totalPending += t.reward;
        if (wasClaimed) {
            // The bond is only in escrow once an agent has claimed; returning a bond that
            // was never taken would mint stake out of the protocol's own balance.
            escrowed -= t.bond;
            totalStakes += t.bond;
            agents[t.agentId].stake += t.bond;
            agents[t.agentId].active -= 1;
        }
        emit VerdictFinalized(id, Verdict.Refunded, 0);
    }

    // ───────────────────────── agent ──────────────────────────
    function registerAgent(string calldata metadataURI, address runner) external payable returns (uint256 agentId) {
        if (msg.value < MIN_BOND || msg.value > type(uint128).max) revert StakeTooSmall();
        if (agentIdOf[msg.sender] != 0) revert AlreadyRegistered();
        agentId = ++agentCount;
        agents[agentId] = Agent({
            operator: msg.sender, runner: runner, metadataURI: metadataURI, stake: uint128(msg.value), active: 0
        });
        agentIdOf[msg.sender] = agentId;
        totalStakes += msg.value;
        emit AgentRegistered(agentId, msg.sender, runner, metadataURI, msg.value);
    }

    function setRunner(uint256 agentId, address runner) external {
        if (agents[agentId].operator != msg.sender) revert NotOperator();
        agents[agentId].runner = runner;
        emit RunnerSet(agentId, runner);
    }

    /// @notice First-come-first-served. The bond moves from the agent's free stake into escrow.
    function claimTrial(uint256 id) external {
        Trial storage t = trials[id];
        if (t.status != Status.Open) revert NotOpen();
        if (block.timestamp >= uint256(uint64(t.timestamps >> 64))) revert DeadlinePassed();
        uint256 aid = agentIdOf[msg.sender];
        if (aid == 0) revert NotAnAgent();
        Agent storage a = agents[aid];
        if (a.stake < t.bond) revert StakeTooSmall();
        a.stake -= t.bond;
        totalStakes -= t.bond;
        escrowed += t.bond;
        a.active += 1;
        t.agentId = uint96(aid);
        t.status = Status.Assigned;
        emit TrialClaimed(id, aid, t.bond);
    }

    function unstake(uint256 agentId, uint256 amount) external {
        Agent storage a = agents[agentId];
        if (a.operator != msg.sender) revert NotOperator();
        if (amount == 0 || amount > a.stake) revert StakeTooSmall();
        a.stake -= uint128(amount);
        totalStakes -= amount;
        credit[msg.sender] += amount;
        totalPending += amount;
        emit StakeWithdrawn(agentId, msg.sender, amount);
    }

    /// @notice Permissionless relay: ANY caller may submit; the EIP-712 signature authorizes it.
    /// @param runHash keccak256(JCS(RunArtifact)) — see docs/run-artifact.v1.json
    /// @param sigDeadline fresh-signed per submission; binds the sig to a time window
    function submitRun(uint256 id, bytes32 runHash, bytes calldata sig, uint64 sigDeadline) external {
        Trial storage t = trials[id];
        if (t.status != Status.Assigned) revert NotAssigned();
        if (block.timestamp >= uint256(uint64(t.timestamps >> 64))) revert DeadlinePassed();
        if (block.timestamp >= sigDeadline) revert SigExpired();
        uint256 aid = t.agentId;
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", DOMAIN, keccak256(abi.encode(RUN_TYPEHASH, id, aid, runHash, sigDeadline)))
        );
        if (_recover(digest, sig) != agents[aid].runner) revert BadSigner();
        t.runHash = runHash;
        _setRunAt(id, uint64(block.timestamp));
        t.status = Status.Judging;
        emit RunSubmitted(id, aid, runHash);
    }

    // ───────────────────────── skeptic ────────────────────────
    /// @notice One break slot per trial (v1). Opening a break opens the Argus dispute clock.
    ///
    /// @dev Neither the sponsor nor the assigned agent may break the trial. The sponsor
    /// buying its own "survived an attack" record is the whole reputation model for the price
    /// of 1% of the reward, refundable on a win — and a win pays the sponsor's own money back
    /// to it plus the skeptic stake, so it is also net positive. The agent has the same
    /// motive through a wallet it controls.
    function fileBreak(uint256 id, bytes32 proofCID) external payable {
        Trial storage t = trials[id];
        if (t.status != Status.Judging) revert NotJudging();
        if (msg.sender == t.sponsor || msg.sender == agents[t.agentId].operator) revert SelfBreak();
        if (block.timestamp > _windowEnd(t)) revert WindowClosed();
        if (msg.value < uint256(t.reward) / BREAK_STAKE_DEN || msg.value > type(uint128).max) revert StakeTooSmall();
        t.breakSkeptic = msg.sender;
        t.breakProofCID = proofCID;
        t.breakStake = uint128(msg.value);
        t.status = Status.Challenged;
        escrowed += msg.value;
        _disputes[id].openedAt = uint64(block.timestamp);
        emit BreakFiled(id, msg.sender, proofCID, msg.value);
        emit DisputeOpened(id);
    }

    // ───────────────────────── argus ──────────────────────────
    /// @param commit keccak256(abi.encodePacked(id, breakWins, salt))
    ///
    /// @dev Sealing is open for `COMMIT_WINDOW` from the dispute opening, and not gated on
    /// the other seats' behaviour. See `COMMIT_WINDOW` for why the old gate — "no commits
    /// once anyone has revealed" — let one seat disenfranchise the other two.
    function commitVote(uint256 id, bytes32 commit) external {
        if (!isArgus[msg.sender]) revert NotArgus();
        if (trials[id].status != Status.Challenged) revert NotChallenged();
        Dispute storage d = _disputes[id];
        if (block.timestamp >= uint256(d.openedAt) + COMMIT_WINDOW) revert CommitClosed();
        if (d.commits[msg.sender] != bytes32(0)) revert AlreadyCommitted();
        d.commits[msg.sender] = commit;
        emit VoteCommitted(id, msg.sender);
    }

    function revealVote(uint256 id, bool breakWins, bytes32 salt) external {
        if (!isArgus[msg.sender]) revert NotArgus();
        Trial storage t = trials[id];
        if (t.status != Status.Challenged) revert NotChallenged();
        Dispute storage d = _disputes[id];
        if (d.commits[msg.sender] == bytes32(0)) revert CommitMismatch();
        if (d.revealed[msg.sender]) revert AlreadyRevealed();
        if (keccak256(abi.encodePacked(id, breakWins, salt)) != d.commits[msg.sender]) revert CommitMismatch();
        d.revealed[msg.sender] = true;
        // Informational only since the commit-window fix: readers use it to see that a
        // dispute has entered the open phase. It must not gate commits again — see
        // `COMMIT_WINDOW`.
        d.revealStarted = true;
        if (breakWins) ++d.votesBreak;
        else ++d.votesAgent;
        emit VoteRevealed(id, msg.sender, breakWins);
        if (d.votesBreak >= ARGUS_THRESHOLD) _settle(id, false);
        else if (d.votesAgent >= ARGUS_THRESHOLD) _settle(id, true);
    }

    // ───────────────────────── settlement ─────────────────────
    /// @notice Permissionless finalization.
    function finalize(uint256 id) external {
        Trial storage t = trials[id];
        if (t.status == Status.Judging) {
            if (block.timestamp < _windowEnd(t)) revert WindowOpen();
            _settle(id, true); // silence is acceptance
        } else if (t.status == Status.Challenged) {
            Dispute storage d = _disputes[id];
            if (block.timestamp < uint256(d.openedAt) + DISPUTE_TIMEOUT) revert DisputeUnresolved();
            _settle(id, true); // burden of proof is on the skeptic
        } else {
            revert NotFinalizable();
        }
    }

    /// Split across three frames rather than one: a single frame holding the trial pointer,
    /// the agent pointer, and both settlement branches exceeds the 16-slot stack under solc's
    /// legacy codegen. It also blocks `forge coverage`, which turns the optimizer off.
    function _settle(uint256 id, bool agentWins) internal {
        {
            Trial storage t = trials[id];
            if (t.status == Status.Settled) revert AlreadySettled();
            t.status = Status.Settled;
            bool hadBreak = t.breakSkeptic != address(0);
            escrowed -= uint256(t.reward) + t.bond + (hadBreak ? uint256(t.breakStake) : 0);
            agents[t.agentId].active -= 1;
            if (agentWins) _settleWin(id);
            else _settleSlash(id);
        }
    }

    function _settleWin(uint256 id) internal {
        Trial storage t = trials[id];
        address operator = agents[t.agentId].operator;
        bool hadBreak = t.breakSkeptic != address(0);
        uint256 reward = t.reward;
        uint256 bond = t.bond;
        uint256 fee = (reward * FEE_BPS) / BPS;

        credit[operator] += reward - fee;
        credit[treasury] += fee;
        totalPending += reward;
        totalStakes += bond;
        agents[t.agentId].stake += uint128(bond); // bond freed

        if (hadBreak) {
            // break failed: the skeptic's stake is halved to the agent and halved to the
            // treasury. The skeptic recovers nothing — the cost of a failed attack
            // (PRD §1.6: "Lose, and half your stake goes to them").
            uint256 bStake = t.breakStake;
            credit[operator] += bStake / 2;
            credit[treasury] += bStake - bStake / 2;
            totalPending += bStake;
        }

        // State first, external calls last.
        //
        // Slither's `reentrancy-no-eth` flags `t.verdict` being written after
        // `alloy.recordWin`. AlloyRegistry is our own contract and cannot reenter, so this
        // is not exploitable today — but writing the verdict before the call costs
        // nothing, makes checks-effects-interactions hold on its face, and means a future
        // change to AlloyRegistry cannot quietly reopen it. `_settle` has already set
        // `t.status = Settled`, so there is a second, independent guard.
        t.verdict = Verdict.Paid;
        alloy.recordWin(t.agentId, operator, hadBreak);
        // ERC-8004: a third-party registry must never be able to block a verdict.
        _publishWin(id, t.agentId, hadBreak);
        emit VerdictFinalized(id, Verdict.Paid, reward - fee);
    }

    function _settleSlash(uint256 id) internal {
        Trial storage t = trials[id];
        address operator = agents[t.agentId].operator;
        uint256 reward = t.reward;
        uint256 bond = t.bond;
        uint256 bStake = t.breakStake;
        uint256 skepticCut = (bond * SLASH_SKEPTIC_NUM) / BPS;

        // slash: sponsor refunded; bond split 30% skeptic / 70% treasury; skeptic stake returned
        credit[t.sponsor] += reward;
        credit[t.breakSkeptic] += skepticCut + bStake;
        credit[treasury] += bond - skepticCut;
        totalPending += reward + bond + bStake;

        // Same ordering rationale as _settleWin: the verdict is written before the external
        // call, so the state a reentrant frame would observe is already final.
        t.verdict = Verdict.Slashed;
        alloy.recordSlash(t.agentId, operator);
        _publishSlash(id, t.agentId);
        emit VerdictFinalized(id, Verdict.Slashed, 0);
    }

    /// @dev A low-level call whose result is deliberately ignored is the only way to
    /// make optional infrastructure non-blocking: a revert inside the bridge would
    /// otherwise roll back the payout. A lost reputation signal can be backfilled via
    /// ReputationBridge.backfill; a stuck verdict cannot be undone.
    function _publishWin(uint256 id, uint256 agentId, bool survivedBreak) internal {
        address bridge = reputationBridge;
        if (bridge == address(0)) return;
        (bool ok,) = bridge.call(abi.encodeCall(ReputationBridge.reportWin, (id, agentId, survivedBreak)));
        ok;
    }

    function _publishSlash(uint256 id, uint256 agentId) internal {
        address bridge = reputationBridge;
        if (bridge == address(0)) return;
        (bool ok,) = bridge.call(abi.encodeCall(ReputationBridge.reportSlash, (id, agentId)));
        ok;
    }

    // ───────────────────────── ledger ─────────────────────────
    function withdraw() external nonReentrant {
        uint256 amt = credit[msg.sender];
        if (amt == 0) revert NothingToWithdraw();
        credit[msg.sender] = 0;
        totalPending -= amt;
        (bool ok,) = msg.sender.call{value: amt}("");
        if (!ok) revert TransferFailed(); // full revert restores the ledger entry
        emit Withdrawn(msg.sender, amt);
    }

    // ───────────────────────── views ──────────────────────────
    function bondFor(uint256 reward) public pure returns (uint256) {
        uint256 b = (reward * BOND_NUM) / BOND_DEN;
        return b < MIN_BOND ? MIN_BOND : b;
    }

    function getTrial(uint256 id) external view returns (Trial memory) {
        return trials[id];
    }

    function getAgent(uint256 id) external view returns (Agent memory) {
        return agents[id];
    }

    function disputeOf(uint256 id)
        external
        view
        returns (uint64 openedAt, bool revealStarted, uint8 votesBreak, uint8 votesAgent)
    {
        Dispute storage d = _disputes[id];
        return (d.openedAt, d.revealStarted, d.votesBreak, d.votesAgent);
    }

    function disputeVote(uint256 id, address judge) external view returns (bytes32 commit, bool revealed) {
        Dispute storage d = _disputes[id];
        return (d.commits[judge], d.revealed[judge]);
    }

    // ───────────────────────── internals ──────────────────────
    /// secp256k1 group order / 2 — the EIP-2 upper bound. A signature with s above
    /// this is the malleable twin of a valid signature and must be rejected.
    uint256 private constant _SECP256K1_HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    /// Split into three frames on purpose: one frame holding digest + r + s + v + the
    /// calldata offset overflows the 16-slot stack under solc's legacy codegen, which
    /// is the configuration `forge coverage` forces.
    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert BadSig();
        (bytes32 r, bytes32 s, uint8 v) = _split(sig);
        if (v < 27) v += 27;
        if (v > 28) revert BadSig();
        if (uint256(s) > _SECP256K1_HALF_N) revert SigMalleable();
        address rec = ecrecover(digest, v, r, s);
        if (rec == address(0)) revert BadSig();
        return rec;
    }

    function _split(bytes calldata sig) private pure returns (bytes32 r, bytes32 s, uint8 v) {
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
    }
}
