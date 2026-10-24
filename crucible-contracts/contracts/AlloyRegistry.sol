// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

/// @title AlloyRegistry — soulbound, outcome-only reputation.
/// One token per agent (tokenId == agentId). Transfers are deliberately not implemented;
/// locked() (ERC-5192) always returns true for minted tokens. Only CrucibleTrials writes.
/// Tier: 0 Unforged · 1 Iron (1 win) · 2 Bronze (3) · 3 Steel (10 & >=1 survived break)
///       · 4 Damascus (25 & >=3 survived). Slash decays wins by 25%.
///
/// ADR-0012: the four figures above are a **window**, and the window belongs to whoever holds the
/// agent's identity. When the identity changes hands the window starts again at zero — but the
/// epoch number, the lifetime book and the event trail do not, so a reset reads as a reset instead
/// of as a clean record. The token itself never moves.
contract AlloyRegistry {
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId); // ERC-721
    event Locked(uint256 indexed tokenId); // ERC-5192
    event TierChanged(uint256 indexed agentId, uint8 tier);
    event ForgeSet(address indexed forge);

    /// @notice The identity behind `agentId` was observed in new hands, and the window started over.
    /// @dev Carries the closed window (`prior*`) so an indexer can reconstruct the epoch that just
    /// ended from the log alone, without a point-in-time read it can no longer make.
    event EpochStarted(
        uint256 indexed agentId,
        uint32 epoch,
        address indexed previousHolder,
        address newHolder,
        uint32 priorWins,
        uint32 priorSurvived,
        uint32 priorSlashes,
        uint64 startedAt
    );

    error NotForge();
    error NotOwner();
    error ForgeAlreadySet();
    error ZeroForge();
    error NotMinted();

    struct Record {
        uint32 wins; // current epoch
        uint32 survived; // current epoch
        uint32 slashes; // current epoch
        uint8 tier; // derived from the current epoch
        uint32 epoch; // 1-based, counts up on every observed handover, never down
        uint32 lifetimeWins; // accumulates across epochs; a slash does not subtract from it
        uint32 lifetimeSlashes; // accumulates across epochs; this is what a reset cannot erase
        address holder; // the identity this window belongs to (NOT `ownerOf`, which never moves)
        uint64 epochStartedAt; // block.timestamp of the transition, so standing can filter honestly
    }

    address public forge;
    address public immutable owner;
    mapping(uint256 => address) public ownerOf; // tokenId == agentId -> operator
    mapping(address => uint256) public balanceOf;
    mapping(uint256 => Record) public records;

    string[5] private _TIER_NAMES = ["Unforged", "Iron", "Bronze", "Steel", "Damascus"];

    modifier onlyForge() {
        if (msg.sender != forge) revert NotForge();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @notice One-time wiring; AlloyRegistry deploys before CrucibleTrials (circular ref).
    ///
    /// @dev Rejects the zero address and emits an event. Without the check, an accidental
    /// `setForge(address(0))` would lock the registry permanently: `forge != address(0)`
    /// is the one-time guard below, so a zero write consumes the only chance to wire it.
    /// `onlyForge` would then be permanently uncallable and no agent could ever earn alloy.
    function setForge(address forge_) external {
        if (msg.sender != owner) revert NotOwner();
        if (forge_ == address(0)) revert ZeroForge();
        if (forge != address(0)) revert ForgeAlreadySet();
        forge = forge_;
        emit ForgeSet(forge_);
    }

    /// @param holder the identity owner the forge observed at settlement (ADR-0012). A zero address
    ///        means "nothing was observed" — an unwired registry, an unlinked agent, or a read that
    ///        failed — and leaves the current holder in place rather than ending an epoch.
    function recordWin(uint256 agentId, address operator, bool survivedBreak, address holder) external onlyForge {
        Record storage r = _bind(agentId, operator, holder);
        r.wins += 1;
        r.lifetimeWins += 1;
        if (survivedBreak) r.survived += 1;
        _applyTier(agentId, r);
    }

    function recordSlash(uint256 agentId, address operator, address holder) external onlyForge {
        Record storage r = _bind(agentId, operator, holder);
        r.slashes += 1;
        r.lifetimeSlashes += 1;
        r.wins = (r.wins * 3) / 4; // decay, applied to the window this slash belongs to
        _applyTier(agentId, r);
    }

    function tierOf(uint256 agentId) external view returns (uint8) {
        return records[agentId].tier;
    }

    /// @notice The history beside the window — what tells a short record apart from a clean one.
    /// @dev Its own read rather than a slice of `records`, for the reason the API already gives for
    /// `tierOf`: a caller that picks a number out of a nine-wide tuple by position can publish a
    /// figure it never measured. A named getter cannot drift that way, and one call answers all four
    /// fields a reader of the epoch needs.
    function epochOf(uint256 agentId)
        external
        view
        returns (uint32 epoch, uint64 startedAt, uint32 lifetimeWins, uint32 lifetimeSlashes)
    {
        Record storage r = records[agentId];
        return (r.epoch, r.epochStartedAt, r.lifetimeWins, r.lifetimeSlashes);
    }

    /// @notice Who the current window belongs to. Not `ownerOf`, which never moves.
    function holderOf(uint256 agentId) external view returns (address) {
        return records[agentId].holder;
    }

    function tierName(uint256 agentId) external view returns (string memory) {
        return _TIER_NAMES[records[agentId].tier];
    }

    function tierNames() external pure returns (string memory) {
        return "Unforged,Iron,Bronze,Steel,Damascus";
    }

    /// @dev ERC-5192. A minted Alloy can never move.
    function locked(uint256 tokenId) external view returns (bool) {
        return ownerOf[tokenId] != address(0);
    }

    /// @notice Fully on-chain JSON — the credential itself has no IPFS dependency.
    /// Assembled in stages: one string.concat with ten arguments overflows the
    /// 16-slot stack under solc's legacy codegen, which breaks `forge coverage`.
    function tokenURI(uint256 agentId) external view returns (string memory) {
        if (ownerOf[agentId] == address(0)) revert NotMinted();
        Record memory r = records[agentId];
        return string.concat(_uriHead(agentId), _uriStats(r), _uriEpoch(r));
    }

    function _uriHead(uint256 agentId) internal view returns (string memory) {
        return string.concat(
            'data:application/json,{"name":"Alloy #',
            _itoa(agentId),
            '","description":"Non-transferable proof of survived Crucible trials.",',
            '"tier":"',
            _TIER_NAMES[records[agentId].tier],
            '"'
        );
    }

    function _uriStats(Record memory r) internal pure returns (string memory) {
        return string.concat(
            ',"wins":', _itoa(r.wins), ',"survived":', _itoa(r.survived), ',"slashes":', _itoa(r.slashes)
        );
    }

    /// @dev The epoch fields close the object. They are in the credential itself, and not only
    /// behind our API, because the claim being made is that a reset is legible to a reader who
    /// trusts none of our services: `epoch` above 1 with a short window says so in the token.
    function _uriEpoch(Record memory r) internal pure returns (string memory) {
        return string.concat(
            ',"epoch":',
            _itoa(r.epoch),
            ',"lifetimeWins":',
            _itoa(r.lifetimeWins),
            ',"lifetimeSlashes":',
            _itoa(r.lifetimeSlashes),
            ',"epochStartedAt":',
            _itoa(r.epochStartedAt),
            "}"
        );
    }

    // ── internals ──

    /// @dev Binds the window to the identity that earned it, and starts a new epoch when that
    /// identity has moved. ADR-0012.
    ///
    /// `ownerOf` is written once and never again: the credential stays with its first holder, which
    /// is the whole soulbound claim (`locked()`, no transfer path, no approval surface). What moves
    /// is `holder` — who controls the ERC-8004 identity the record scores — and moving it closes the
    /// window instead of rewriting history.
    function _bind(uint256 agentId, address operator, address holder) internal returns (Record storage r) {
        r = records[agentId];
        if (ownerOf[agentId] == address(0)) {
            ownerOf[agentId] = operator;
            balanceOf[operator] += 1;
            emit Transfer(address(0), operator, agentId);
            emit Locked(agentId);
        }

        if (r.holder == address(0)) {
            // First outcome ever recorded for this agent: epoch 1, owned by whoever holds the
            // identity now (the operator, when nothing was observed).
            r.holder = holder == address(0) ? operator : holder;
            r.epoch = 1;
            r.epochStartedAt = uint64(block.timestamp);
            return r;
        }

        if (holder == address(0) || holder == r.holder) return r;

        emit EpochStarted(
            agentId, r.epoch + 1, r.holder, holder, r.wins, r.survived, r.slashes, uint64(block.timestamp)
        );
        r.epoch += 1;
        r.holder = holder;
        r.wins = 0;
        r.survived = 0;
        r.slashes = 0;
        r.epochStartedAt = uint64(block.timestamp);
        _applyTier(agentId, r); // recomputes to Unforged: the buyer has not earned anything yet
    }

    function _applyTier(uint256 agentId, Record storage r) internal {
        uint8 t = _tierFor(r.wins, r.survived);
        if (t != r.tier) {
            r.tier = t;
            emit TierChanged(agentId, t);
        }
    }

    function _tierFor(uint32 wins, uint32 survived) public pure returns (uint8) {
        if (wins >= 25 && survived >= 3) return 4;
        if (wins >= 10 && survived >= 1) return 3;
        if (wins >= 3) return 2;
        if (wins >= 1) return 1;
        return 0;
    }

    function _itoa(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 digits;
        uint256 t = v;
        while (t != 0) {
            digits++;
            t /= 10;
        }
        bytes memory buf = new bytes(digits);
        while (v != 0) {
            buf[--digits] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(buf);
    }
}
