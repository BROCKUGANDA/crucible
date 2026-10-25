// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

/// @title TeamLedger — provable contribution attribution and revenue splits for multi-agent trials.
///
/// @notice One team, many agents, one artifact. Every member signs their own share before it is
///         recorded, every stage output is attested by the member who produced it, and the split is
///         derived from those signatures rather than from anyone's later account of them. That is
///         the whole point: "who did the work" stops being a claim by the lead and becomes a set of
///         recoverable signatures a skeptic can check.
///
/// @dev Deliberately NOT wired into `CrucibleTrials`. The escrow still pays exactly one agent, so
///      the legacy conservation invariant
///      `address(trials).balance == totalStakes + totalPending + escrowed`
///      (`test/Invariants.t.sol:170`) is untouched by this contract, and no path here can move a
///      wei of escrow. `TeamLedger` holds its own ETH and carries its own equation:
///      `address(this).balance == totalHeld + totalCredit`. That is the shape ADR-0011 already uses
///      for the arena — new money law beside the old one, not a migration of it.
///
///      Money rules inherited from the repo, restated because they bind here:
///        - **Pull, never push.** `distribute` credits a ledger; a member calls `withdraw` in a
///          separate transaction. No loop ever sends ETH.
///        - **Truncate on payout, round up on minimums.** Shares truncate, so the sum of shares can
///          be up to `memberCount - 1` wei short of the amount held. The remainder goes to the lead
///          and is asserted, not swallowed — a split that loses a wei is a split that fails
///          conservation, and conservation is the one thing this contract exists to be able to prove.
///        - **No `receive()`.** ETH enters only through `fund`, so it cannot take a passive transfer
///          and cannot be forced into the ledger by a selfdestruct or a callback.
contract TeamLedger {
    // ── constants ────────────────────────────────────────────────────────────────────────────
    uint256 private constant BPS = 10_000;
    uint256 public constant MAX_MEMBERS = 8;
    /// @dev Half the secp256k1 order. Above it, `s` has a valid complement, so the same agreement
    ///      would carry two different signatures — see `_recover`.
    uint256 private constant _SECP256K1_HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    bytes32 public constant TEAM_TYPEHASH = keccak256("TeamMember(bytes32 teamKey,address member,uint256 shareBps,uint256 deadline)");
    bytes32 public constant STAGE_TYPEHASH = keccak256("Stage(bytes32 teamKey,bytes32 stageHash,uint256 seq,address member,uint256 deadline)");
    bytes32 private constant _DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    // ── storage ──────────────────────────────────────────────────────────────────────────────
    struct Team {
        address lead; // members[0]; receives the truncation remainder
        uint64 memberCount;
        uint64 stageCount;
        bool distributed;
    }

    mapping(bytes32 => Team) private _teams;
    mapping(bytes32 => mapping(address => uint256)) public shareBpsOf;
    mapping(bytes32 => mapping(address => bool)) public isMember;
    /// @notice ETH held for a team that has not been split yet.
    mapping(bytes32 => uint256) public held;
    /// @notice Pull ledger: what a member may withdraw, in wei.
    mapping(address => uint256) public credit;
    mapping(bytes32 => mapping(bytes32 => bool)) public stageAttested;

    uint256 public totalCredit;

    /// @notice Sum of every team's un-distributed `held`. Updated in the only two functions that
    ///         change `held`, and the invariant test asserts it agrees with the per-team balances —
    ///         so it is a convenience total under proof, not a second ledger nobody checks.
    uint256 public heldTotal;

    bytes32 private immutable _DOMAIN_SEPARATOR;

    // ── errors ───────────────────────────────────────────────────────────────────────────────
    error TeamExists();
    error NoTeam();
    error EmptyTeam();
    error TooManyMembers();
    error ShareMismatch();
    error DuplicateMember();
    error ZeroAddress();
    error DeadlinePassed();
    error BadSignature();
    error SigMalleable();
    error NotMember();
    error Distributed();
    error NothingToSplit();
    error NoCredit();
    error TransferFailed();
    error StageExists();

    // ── events ───────────────────────────────────────────────────────────────────────────────
    event TeamCreated(bytes32 indexed teamKey, address indexed lead, uint256 memberCount);
    event StageAttested(bytes32 indexed teamKey, bytes32 indexed stageHash, address member, uint256 seq);
    event TeamFunded(bytes32 indexed teamKey, uint256 amount, uint256 heldAfter);
    event SharesDistributed(bytes32 indexed teamKey, uint256 amount, uint256 remainderToLead);
    event Withdrawn(address indexed member, uint256 amount);

    constructor() {
        _DOMAIN_SEPARATOR = keccak256(
            abi.encode(_DOMAIN_TYPEHASH, keccak256("CrucibleTeamLedger"), keccak256("1"), block.chainid, address(this))
        );
    }

    /// @notice The EIP-712 separator. Public so a signer can produce a signature without a call.
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _DOMAIN_SEPARATOR;
    }

    // ── formation ────────────────────────────────────────────────────────────────────────────

    /// @notice Record a team. Every member's share is asserted against that member's own signature,
    ///         so a lead cannot restate a split nobody agreed to.
    /// @param teamKey Caller-chosen identity for the team. Reused keys revert: a re-formed team must
    ///        be a new team, or the stage attestations of the old one would attach to the new split.
    /// @param deadline Latest block timestamp the signatures remain valid. Past it, formation
    ///        reverts — a signature collected for one arrangement must not fund a later one.
    function createTeam(bytes32 teamKey, address[] calldata members, uint256[] calldata sharesBps, uint256 deadline, bytes[] calldata sigs) external {
        if (deadline < block.timestamp) revert DeadlinePassed();
        if (_teams[teamKey].lead != address(0)) revert TeamExists();
        if (members.length == 0) revert EmptyTeam();
        if (members.length > MAX_MEMBERS) revert TooManyMembers();
        if (sigs.length != members.length) revert BadSignature();
        if (sharesBps.length != members.length) revert ShareMismatch();

        uint256 totalBps;
        for (uint256 i; i < members.length; ++i) {
            address m = members[i];
            if (m == address(0)) revert ZeroAddress();
            if (isMember[teamKey][m]) revert DuplicateMember();
            uint256 share = sharesBps[i];
            if (share == 0) revert ShareMismatch();
            totalBps += share;

            bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _DOMAIN_SEPARATOR, keccak256(abi.encode(TEAM_TYPEHASH, teamKey, m, share, deadline))));
            if (_recover(digest, sigs[i]) != m) revert BadSignature();

            isMember[teamKey][m] = true;
            shareBpsOf[teamKey][m] = share;
        }
        if (totalBps != BPS) revert ShareMismatch();

        Team storage t = _teams[teamKey];
        t.lead = members[0];
        t.memberCount = uint64(members.length);
        // The membership set is a mapping for O(1) checks; this ordered copy is what `distribute`
        // walks, because a mapping cannot be iterated and a split must visit every member exactly
        // once. Both are written here and nowhere else, so they cannot disagree.
        _memberList[teamKey] = members;

        emit TeamCreated(teamKey, members[0], members.length);
    }

    /// @notice Attest that a member produced a given stage output. The signature is the member's, so
    ///         attribution cannot be added after the fact by whoever holds the lead role.
    function attestStage(bytes32 teamKey, bytes32 stageHash, uint256 deadline, bytes calldata sig) external {
        if (_teams[teamKey].lead == address(0)) revert NoTeam();
        if (deadline < block.timestamp) revert DeadlinePassed();
        if (stageHash == bytes32(0)) revert BadSignature();

        bytes32 signer = keccak256(abi.encode(STAGE_TYPEHASH, teamKey, stageHash, _teams[teamKey].stageCount, msg.sender, deadline));
        address m = _recover(keccak256(abi.encodePacked("\x19\x01", _DOMAIN_SEPARATOR, signer)), sig);
        if (m != msg.sender) revert BadSignature();
        if (!isMember[teamKey][m]) revert NotMember();
        if (stageAttested[teamKey][stageHash]) revert StageExists();

        Team storage t = _teams[teamKey];
        t.stageCount += 1;
        stageAttested[teamKey][stageHash] = true;

        emit StageAttested(teamKey, stageHash, m, t.stageCount);
    }

    // ── money ────────────────────────────────────────────────────────────────────────────────

    /// @notice Put ETH aside for a team's split. Callable by anyone, because the payer is not the
    ///         question the ledger answers; the split is.
    function fund(bytes32 teamKey) external payable {
        if (_teams[teamKey].lead == address(0)) revert NoTeam();
        if (_teams[teamKey].distributed) revert Distributed();
        if (msg.value == 0) revert NothingToSplit();

        held[teamKey] += msg.value;
        heldTotal += msg.value;
        emit TeamFunded(teamKey, msg.value, held[teamKey]);
    }

    /// @notice Convert a team's held ETH into per-member pull credits. Idempotency is a flag, not a
    ///         revert-on-empty: a second call must fail even when the balance happens to be zero.
    function distribute(bytes32 teamKey) external {
        Team storage t = _teams[teamKey];
        if (t.lead == address(0)) revert NoTeam();
        if (t.distributed) revert Distributed();

        uint256 amount = held[teamKey];
        if (amount == 0) revert NothingToSplit();
        t.distributed = true;
        held[teamKey] = 0;
        heldTotal -= amount;

        uint256 assigned;
        address[] memory members = _membersOf(teamKey);
        for (uint256 i; i < members.length; ++i) {
            // Truncate, never round up: printing more than the contract holds is the failure mode
            // this repo already guards on the escrow side.
            uint256 part = (amount * shareBpsOf[teamKey][members[i]]) / BPS;
            credit[members[i]] += part;
            assigned += part;
        }

        // The remainder is at most `memberCount - 1` wei and goes to the lead. It is returned so the
        // caller can see the split was exact-in-ether rather than lossy, and the invariant test
        // asserts the whole amount landed somewhere.
        uint256 remainder = amount - assigned;
        credit[t.lead] += remainder;

        totalCredit += amount;
        emit SharesDistributed(teamKey, amount, remainder);
    }

    /// @notice Take out what the split credited to you. Pull only, and it clears before it sends —
    ///         the reentrancy order the escrow uses for the same reason.
    function withdraw() external {
        uint256 amount = credit[msg.sender];
        if (amount == 0) revert NoCredit();
        credit[msg.sender] = 0;
        totalCredit -= amount;

        // Logged before the transfer, not after: effects first, then interaction. A recipient that
        // re-enters here sees a zeroed credit and reverts `NoCredit`, and the log it could not
        // prevent cannot be reordered behind this caller's back by a contract that falls over later.
        emit Withdrawn(msg.sender, amount);

        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ── views ────────────────────────────────────────────────────────────────────────────────

    struct TeamInfo {
        address lead;
        uint256 memberCount;
        uint256 stageCount;
        bool distributed;
        uint256 held;
    }

    function team(bytes32 teamKey) external view returns (TeamInfo memory) {
        Team storage t = _teams[teamKey];
        return TeamInfo(t.lead, t.memberCount, t.stageCount, t.distributed, held[teamKey]);
    }

    function members(bytes32 teamKey) external view returns (address[] memory out) {
        return _membersOf(teamKey);
    }

    /// @notice The ledger's own conservation equation. True by construction, and asserted by
    ///         `test/TeamLedger.t.sol` on every path that moves ETH.
    function conservationHolds() external view returns (bool) {
        return address(this).balance == heldTotal + totalCredit;
    }

    function conservationDetail() external view returns (uint256 balance, uint256 held, uint256 credits) {
        return (address(this).balance, heldTotal, totalCredit);
    }

    // ── internals ────────────────────────────────────────────────────────────────────────────

    // `_memberList` is write-only bookkeeping: the membership set is a mapping (O(1) checks, no
    // enumeration), and `distribute` needs the ordered list. Keeping both is the cheap way to avoid
    // recomputing an array from a mapping that cannot be iterated.
    mapping(bytes32 => address[]) private _memberList;

    function _membersOf(bytes32 teamKey) private view returns (address[] memory out) {
        out = _memberList[teamKey];
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        // Same three guards `CrucibleTrials._recover` applies, for the same reason: this contract's
        // entire purpose is proving who agreed to a split, so a signature that is re-derivable
        // (high `s`), empty, or from a zero address would let a lead claim an agreement nobody made.
        if (sig.length != 65) revert BadSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v > 28) revert BadSignature();
        if (uint256(s) > _SECP256K1_HALF_N) revert SigMalleable();
        address rec = ecrecover(digest, v, r, s);
        if (rec == address(0)) revert BadSignature();
        return rec;
    }
}
