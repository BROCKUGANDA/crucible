// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title RewardsTreasury — per-campaign budget accounting (REW-004).
/// @notice Admin (Safe) funds campaigns; claims debit claimed. Invariants:
///         claimed <= funded <= budget. No campaign may be over-claimed.
contract RewardsTreasury {
    address public admin;

    struct Campaign {
        uint256 budget;
        uint256 funded;
        uint256 claimed;
        bool active;
    }

    mapping(uint256 => Campaign) public campaigns;

    event CampaignBudgetSet(uint256 indexed id, uint256 budget);
    event CampaignFunded(uint256 indexed id, uint256 amount, uint256 funded);
    event ClaimRecorded(uint256 indexed id, uint256 amount, uint256 claimed);
    event CampaignToggled(uint256 indexed id, bool active);
    event AdminChanged(address indexed previousAdmin, address indexed newAdmin);

    error NotAdmin();
    error UnknownCampaign();
    error Inactive();
    error OverBudget();
    error OverFunded();
    error OverClaimed();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor() {
        admin = msg.sender;
    }

    function setAdmin(address newAdmin) external onlyAdmin {
        emit AdminChanged(admin, newAdmin);
        admin = newAdmin;
    }

    function setBudget(uint256 id, uint256 budget) external onlyAdmin {
        Campaign storage c = campaigns[id];
        if (c.budget == 0 && c.funded == 0 && c.claimed == 0) {
            // new campaign
        }
        if (budget < c.funded) revert OverFunded();
        c.budget = budget;
        c.active = true;
        emit CampaignBudgetSet(id, budget);
    }

    function fund(uint256 id, uint256 amount) external onlyAdmin {
        Campaign storage c = campaigns[id];
        if (c.budget == 0 && c.funded == 0 && c.claimed == 0) revert UnknownCampaign();
        if (!c.active) revert Inactive();
        if (c.funded + amount > c.budget) revert OverFunded();
        c.funded += amount;
        emit CampaignFunded(id, amount, c.funded);
    }

    function recordClaim(uint256 id, uint256 amount) external onlyAdmin {
        Campaign storage c = campaigns[id];
        if (!c.active) revert Inactive();
        if (c.claimed + amount > c.funded) revert OverClaimed();
        c.claimed += amount;
        emit ClaimRecorded(id, amount, c.claimed);
    }

    function toggle(uint256 id, bool active) external onlyAdmin {
        campaigns[id].active = active;
        emit CampaignToggled(id, active);
    }

    function remaining(uint256 id) external view returns (uint256) {
        Campaign storage c = campaigns[id];
        return c.funded - c.claimed;
    }
}
