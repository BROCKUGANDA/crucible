// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Test double for the ERC-8004 Reputation Registry.
/// @dev Enforces the spec's two rules that matter to Crucible, so the tests prove
/// Crucible's output is actually consumable by a conforming registry rather than
/// just that a call didn't revert:
///   1. `valueDecimals` must be 0-18.
///   2. The submitter MUST NOT be the agent's owner or an approved operator.
contract MockReputationRegistry {
    struct Feedback {
        int128 value;
        uint8 valueDecimals;
        string tag1;
        string tag2;
        address clientAddress;
        bool revoked;
        bool exists;
    }

    address public identityRegistry;

    mapping(uint256 => mapping(address => uint64)) public lastIndex;
    mapping(uint256 => mapping(address => mapping(uint64 => Feedback))) private _feedback;
    mapping(uint256 => address) public agentOwner;
    mapping(uint256 => mapping(address => bool)) public operators;
    mapping(uint256 => bool) public agentRegistered;

    uint256 public feedbackCount;
    /// set to true to simulate a registry outage, so Crucible's try/catch path is tested
    bool public shouldRevert;

    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string tag1,
        string tag2
    );
    event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex);

    error DecimalsOutOfRange();
    error AgentNotRegistered();
    error SelfFeedbackForbidden();

    function initialize(address identityRegistry_) external {
        identityRegistry = identityRegistry_;
    }

    // ── test setup ──
    function setAgent(uint256 agentId, address owner_, bool isOperator) external {
        agentRegistered[agentId] = true;
        agentOwner[agentId] = owner_;
        operators[agentId][owner_] = isOperator;
    }

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    // ── ERC-8004 giveFeedback ──
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata, /* endpoint */
        string calldata, /* feedbackURI */
        bytes32 /* feedbackHash */
    ) external {
        if (shouldRevert) revert("registry down");
        if (valueDecimals > 18) revert DecimalsOutOfRange();
        if (!agentRegistered[agentId]) revert AgentNotRegistered();
        // the spec's core anti-self-dealing rule
        if (msg.sender == agentOwner[agentId] || operators[agentId][msg.sender]) {
            revert SelfFeedbackForbidden();
        }

        uint64 idx = ++lastIndex[agentId][msg.sender];
        _feedback[agentId][msg.sender][idx] = Feedback({
            value: value,
            valueDecimals: valueDecimals,
            tag1: tag1,
            tag2: tag2,
            clientAddress: msg.sender,
            revoked: false,
            exists: true
        });
        feedbackCount++;
        emit NewFeedback(agentId, msg.sender, idx, value, valueDecimals, tag1, tag2);
    }

    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external {
        Feedback storage f = _feedback[agentId][msg.sender][feedbackIndex];
        f.revoked = true;
        emit FeedbackRevoked(agentId, msg.sender, feedbackIndex);
    }

    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64) {
        return lastIndex[agentId][clientAddress];
    }

    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked)
    {
        Feedback storage f = _feedback[agentId][clientAddress][feedbackIndex];
        return (f.value, f.valueDecimals, f.tag1, f.tag2, f.revoked);
    }

    /// Aggregates by tag, which is how an aggregator would read Crucible's signal.
    function getSummary(uint256 agentId, address[] calldata clientAddresses, string memory tag1, string memory)
        external
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)
    {
        for (uint256 i; i < clientAddresses.length; ++i) {
            uint64 n = lastIndex[agentId][clientAddresses[i]];
            for (uint64 j = 1; j <= n; ++j) {
                Feedback storage f = _feedback[agentId][clientAddresses[i]][j];
                if (!f.exists || f.revoked) continue;
                if (keccak256(bytes(f.tag1)) != keccak256(bytes(tag1))) continue;
                count++;
                summaryValue += f.value;
                summaryValueDecimals = f.valueDecimals;
            }
        }
    }
}

/// @notice Test double for the ERC-8004 Identity Registry.
/// @dev Holds to the one property Crucible depends on: `register(agentURI)` mints the
/// attestation to `msg.sender`, which is why the operator — never CrucibleTrials — has
/// to make the call. TokenIds start at 1 so a zero link stays impossible.
contract MockIdentityRegistry {
    event Registered(uint256 indexed agentId, string agentURI, address regAddr, string provider);
    event AgentURIUpdated(uint256 indexed agentId, address agentAddress, string agentURI);

    uint256 private _nextId;
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => string) public agentURI;

    function register(string calldata uri) external returns (uint256 agentId) {
        agentId = ++_nextId;
        ownerOf[agentId] = msg.sender;
        agentURI[agentId] = uri;
        emit Registered(agentId, uri, msg.sender, "crucible-local-mock");
    }

    function setAgentURI(uint256 agentId, string calldata newURI) external {
        require(msg.sender == ownerOf[agentId], "not owner");
        agentURI[agentId] = newURI;
        emit AgentURIUpdated(agentId, ownerOf[agentId], newURI);
    }

    function getVersion() external pure returns (string memory) {
        return "local-mock";
    }
}
