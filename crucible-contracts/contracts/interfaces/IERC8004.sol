// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Minimal subset of the ERC-8004 Identity Registry that Crucible consumes.
/// @dev Draft ERC (https://eips.ethereum.org/EIPS/eip-8004). Declared locally rather
/// than imported so the contracts build with no external dependency; the signatures
/// match the spec exactly.
interface IERC8004IdentityRegistry {
    function register(string calldata agentURI) external returns (uint256 agentId);
    function register(string calldata agentURI, MetadataEntry[] calldata metadata) external returns (uint256 agentId);
    function setAgentURI(uint256 agentId, string calldata newURI) external;
    function agentURI(uint256 agentId) external view returns (string memory);
    function ownerOf(uint256 agentId) external view returns (address);
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external;
    function getAgentWallet(uint256 agentId) external view returns (address);
    function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory);

    struct MetadataEntry {
        string metadataKey;
        bytes metadataValue;
    }
}

/// @notice Minimal subset of the ERC-8004 Reputation Registry.
/// @dev The critical rule, quoted from the spec: "The feedback submitter MUST NOT be
/// the agent owner or an approved operator for agentId." Crucible satisfies this by
/// having CrucibleTrials — not the operator — call giveFeedback.
interface IERC8004ReputationRegistry {
    function getIdentityRegistry() external view returns (address);

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;

    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external;

    function getSummary(
        uint256 agentId,
        address[] calldata clientAddresses,
        string memory tag1,
        string memory tag2
    ) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);

    function readFeedback(
        uint256 agentId,
        address clientAddress,
        uint64 feedbackIndex
    ) external view returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked);

    function readAllFeedback(
        uint256 agentId,
        address[] calldata clientAddresses,
        string memory tag1,
        string memory tag2,
        bool includeRevoked
    )
        external
        view
        returns (
            address[] memory clients,
            uint64[] memory feedbackIndexes,
            int128[] memory values,
            uint8[] memory valueDecimals,
            string[] memory tag1s,
            string[] memory tag2s,
            bool[] memory revokedStatuses
        );

    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64);
}

/// @notice Minimal subset of the ERC-8004 Validation Registry.
/// @dev No mainnet deployment exists as of this writing, so Crucible treats it as
/// optional: if the address is unset, validation requests are simply not sent.
interface IERC8004ValidationRegistry {
    function validationRequest(
        address validatorAddress,
        uint256 agentId,
        string calldata requestURI,
        bytes32 requestHash
    ) external;

    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external;

    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string memory tag, uint256 lastUpdate);
}
