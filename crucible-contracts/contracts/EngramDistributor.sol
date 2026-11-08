// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IEngram1155 {
    function mint(address to, uint256 tokenId, uint256 amount, bytes32 evidenceRef) external;
}

/// @title EngramDistributor — Merkle-based claim distributor (REW-003).
/// @notice Campaigns are funded with token inventory; recipients claim via
///         Merkle proof. Each campaign has a root, budget, and claim window.
///         The leaf binds chain id + recipient + amount + campaign id +
///         token id, so a root published on one chain (or for one token)
///         cannot be replayed on another. A claim mints through the
///         ERC-1155 collection, so the on-chain balance — not an event —
///         is the record of the distribution. With `engram == address(0)`
///         the distributor is a pure Merkle verifier (tests, dry runs).
contract EngramDistributor {
    address public immutable admin;
    address public immutable engram; // EngramERC1155 address; zero = no mint leg

    struct Campaign {
        bytes32 merkleRoot;
        uint256 tokenId;
        uint256 budget; // max claims
        uint256 claimed;
        uint64 start;
        uint64 end;
        bool paused;
    }

    mapping(uint256 => Campaign) public campaigns;
    mapping(uint256 => mapping(address => bool)) public hasClaimed;
    uint256 public campaignCount;

    event CampaignCreated(
        uint256 indexed campaignId, bytes32 root, uint256 tokenId, uint256 budget, uint64 start, uint64 end
    );
    event Claimed(uint256 indexed campaignId, address indexed recipient, uint256 amount);
    event CampaignPaused(uint256 indexed campaignId, bool paused);

    error NotAdmin();
    error CampaignNotFound();
    error CampaignPausedErr();
    error OutsideWindow();
    error AlreadyClaimed();
    error BudgetExhausted();
    error InvalidProof();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address engram_) {
        admin = msg.sender;
        engram = engram_;
    }

    function createCampaign(bytes32 root, uint256 tokenId, uint256 budget, uint64 start, uint64 end)
        external
        onlyAdmin
        returns (uint256 id)
    {
        require(start < end, "bad window");
        id = campaignCount++;
        campaigns[id] = Campaign(root, tokenId, budget, 0, start, end, false);
        emit CampaignCreated(id, root, tokenId, budget, start, end);
    }

    function pauseCampaign(uint256 id, bool paused) external onlyAdmin {
        if (id >= campaignCount) revert CampaignNotFound();
        campaigns[id].paused = paused;
        emit CampaignPaused(id, paused);
    }

    function claim(uint256 campaignId, uint256 amount, bytes32[] calldata proof) external {
        if (campaignId >= campaignCount) revert CampaignNotFound();
        Campaign storage c = campaigns[campaignId];
        if (c.paused) revert CampaignPausedErr();
        if (block.timestamp < c.start || block.timestamp > c.end) revert OutsideWindow();
        if (hasClaimed[campaignId][msg.sender]) revert AlreadyClaimed();
        if (c.claimed + amount > c.budget) revert BudgetExhausted();

        bytes32 leaf = keccak256(abi.encodePacked(block.chainid, msg.sender, amount, campaignId, c.tokenId));
        if (!_verify(proof, c.merkleRoot, leaf)) revert InvalidProof();

        // State first, external call last: the claim is recorded before any
        // mint, so a receiver that could reenter would find it spent.
        hasClaimed[campaignId][msg.sender] = true;
        c.claimed += amount;

        if (engram != address(0)) {
            // The leaf is the evidence reference: it binds who was approved,
            // for what, on which chain, for which token and campaign.
            IEngram1155(engram).mint(msg.sender, c.tokenId, amount, leaf);
        }
        emit Claimed(campaignId, msg.sender, amount);
    }

    function _verify(bytes32[] calldata proof, bytes32 root, bytes32 leaf) internal pure returns (bool) {
        bytes32 computed = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            if (computed <= p) {
                computed = keccak256(abi.encodePacked(computed, p));
            } else {
                computed = keccak256(abi.encodePacked(p, computed));
            }
        }
        return computed == root;
    }
}
