// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title EngramDistributor — Merkle-based claim distributor (REW-003).
/// @notice Campaigns are funded with token inventory; recipients claim via
///         Merkle proof. Each campaign has a root, budget, and claim window.
contract EngramDistributor {
    address public admin;
    address public engram; // EngramERC1155 address (informational)

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

    event CampaignCreated(uint256 indexed campaignId, bytes32 root, uint256 tokenId, uint256 budget, uint64 start, uint64 end);
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

    function createCampaign(bytes32 root, uint256 tokenId, uint256 budget, uint64 start, uint64 end) external onlyAdmin returns (uint256 id) {
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

        bytes32 leaf = keccak256(abi.encodePacked(msg.sender, amount, campaignId));
        if (!_verify(proof, c.merkleRoot, leaf)) revert InvalidProof();

        hasClaimed[campaignId][msg.sender] = true;
        c.claimed += amount;
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
