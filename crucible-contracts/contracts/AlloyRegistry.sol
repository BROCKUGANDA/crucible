// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title AlloyRegistry — soulbound, outcome-only reputation.
/// One token per agent (tokenId == agentId). Transfers are deliberately not implemented;
/// locked() (ERC-5192) always returns true for minted tokens. Only CrucibleTrials writes.
/// Tier: 0 Unforged · 1 Iron (1 win) · 2 Bronze (3) · 3 Steel (10 & >=1 survived break)
///       · 4 Damascus (25 & >=3 survived). Slash decays wins by 25%.
contract AlloyRegistry {
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId); // ERC-721
    event Locked(uint256 indexed tokenId); // ERC-5192
    event TierChanged(uint256 indexed agentId, uint8 tier);

    error NotForge();
    error NotOwner();
    error ForgeAlreadySet();
    error NotMinted();

    struct Record {
        uint32 wins;
        uint32 survived;
        uint32 slashes;
        uint8 tier;
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
    function setForge(address forge_) external {
        if (msg.sender != owner) revert NotOwner();
        if (forge != address(0)) revert ForgeAlreadySet();
        forge = forge_;
    }

    function recordWin(uint256 agentId, address operator, bool survivedBreak) external onlyForge {
        _ensure(agentId, operator);
        Record storage r = records[agentId];
        r.wins += 1;
        if (survivedBreak) r.survived += 1;
        _applyTier(agentId, r);
    }

    function recordSlash(uint256 agentId, address operator) external onlyForge {
        _ensure(agentId, operator);
        Record storage r = records[agentId];
        r.slashes += 1;
        r.wins = (r.wins * 3) / 4; // decay
        _applyTier(agentId, r);
    }

    function tierOf(uint256 agentId) external view returns (uint8) {
        return records[agentId].tier;
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
        return string.concat(_uriHead(agentId), _uriStats(r));
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
        return string.concat(',"wins":', _itoa(r.wins), ',"survived":', _itoa(r.survived), ',"slashes":', _itoa(r.slashes), "}");
    }

    // ── internals ──
    function _ensure(uint256 agentId, address operator) internal {
        if (ownerOf[agentId] == address(0)) {
            ownerOf[agentId] = operator;
            balanceOf[operator] += 1;
            emit Transfer(address(0), operator, agentId);
            emit Locked(agentId);
        }
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
