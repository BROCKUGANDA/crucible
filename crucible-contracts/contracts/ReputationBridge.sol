// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC8004ReputationRegistry, IERC8004IdentityRegistry} from "./interfaces/IERC8004.sol";

/// @title ReputationBridge
/// @notice Writes Crucible outcomes into an ERC-8004 Reputation Registry.
///
/// @dev The design point that matters: ERC-8004 forbids the agent's owner from
/// submitting feedback about their own agent. Crucible therefore never lets the
/// operator speak. Only this bridge — called by CrucibleTrials at settlement, or by
/// an Argus seat when a verdict lands — can write, so `clientAddress` on-chain is
/// always a neutral reporter rather than the party being judged.
///
/// Feedback is opt-in per deployment: if `reputationRegistry` is unset, every call
/// is a silent no-op rather than a revert. A Crucible deployment should never be
/// bricked because a third-party registry is down.
contract ReputationBridge {
    /// Feedback tag pair, so an aggregator can filter Crucible signals from other
    /// feedback on the same agent. Matches the spec's tag1/tag2 convention.
    string public constant TAG1 = "crucible";
    string public constant TAG2 = "verdict";

    /// Reputation is reported on a 0-1000 scale with 1 decimal (valueDecimals = 1),
    /// leaving headroom above the spec's example 0-100 "starred" convention.
    uint8 public constant VALUE_DECIMALS = 1;
    int128 public constant MAX_VALUE = 1000;

    address public immutable trials;
    IERC8004ReputationRegistry public reputationRegistry;

    /// Feedback index per agent, so a later revoke knows what to revoke.
    mapping(uint256 => uint64) public lastFeedbackIndex;

    event ReputationRegistrySet(address indexed registry);
    event FeedbackPublished(
        uint256 indexed agentId, uint256 indexed trialsId, int128 value, bool survivedBreak, uint64 feedbackIndex
    );

    error NotTrials();
    error UnauthorizedReporter();
    error ValueOutOfRange();
    error NoReputationRegistry();
    error NotRegistryOwner();

    /// The deployer. Holds no funds and no trial authority — only registry plumbing.
    address public immutable owner;

    constructor(address trials_) {
        if (trials_ == address(0)) revert NotTrials();
        trials = trials_;
        owner = msg.sender;
    }

    /// Deployer-only wiring, so a per-chain singleton can be pointed at after the
    /// bridge exists. Deliberately not the operator: the operator is the party being
    /// judged, and letting them choose their own registry would defeat the point.
    function setReputationRegistry(address registry) external {
        if (msg.sender != owner) revert NotRegistryOwner();
        reputationRegistry = IERC8004ReputationRegistry(registry);
        emit ReputationRegistrySet(registry);
    }

    /**
     * Publish a paid verdict.
     *
     * Value encodes survived-ness on a 0-1000 scale, weighted so that surviving an
     * attack is worth strictly more than a quiet win — an agent that has been
     * attacked and held is the whole point of the protocol.
     */
    function reportWin(uint256 trialsId, uint256 agentId, bool survivedBreak) external {
        _authorize();
        int128 value = survivedBreak ? int128(750) : int128(500);
        _publish(trialsId, agentId, value, survivedBreak);
    }

    /// Publish a slash. Value is negative and always larger in magnitude than a slash
    /// for an untested agent, so reputation decays faster the more it was trusted.
    function reportSlash(uint256 trialsId, uint256 agentId) external {
        _authorize();
        _publish(trialsId, agentId, -int128(400), false);
    }

    /// Anyone may publish for an already-settled trial. Useful for an indexer
    /// backfilling if a settlement happened before the registry was wired.
    function backfill(uint256 trialsId, uint256 agentId, int128 value) external {
        if (value == 0 || value > MAX_VALUE || value < -MAX_VALUE) revert ValueOutOfRange();
        _publish(trialsId, agentId, value, value > 0);
    }

    function _publish(uint256 trialsId, uint256 agentId, int128 value, bool survivedBreak) private {
        address registry = address(reputationRegistry);
        // A missing or unavailable registry degrades the *signal*, never the verdict.
        if (registry == address(0)) revert NoReputationRegistry();

        string memory uri = string.concat("crucible://trials/", _toString(trialsId));
        IERC8004ReputationRegistry(registry)
            .giveFeedback(
                agentId,
                value,
                VALUE_DECIMALS,
                TAG1,
                TAG2,
                uri,
                uri,
                bytes32(0) // content-addressed URI: the spec says feedbackHash is optional
            );

        lastFeedbackIndex[agentId] = IERC8004ReputationRegistry(registry).getLastIndex(agentId, address(this));
        emit FeedbackPublished(agentId, trialsId, value, survivedBreak, lastFeedbackIndex[agentId]);
    }

    /// CrucibleTrials at settlement, or an Argus seat acting for it. Not the operator:
    /// the operator is the party being judged, so allowing it here would both break
    /// the ERC-8004 rule and make the reputation signal worthless.
    function _authorize() private view {
        if (msg.sender != trials) revert UnauthorizedReporter();
    }

    function _toString(uint256 v) private pure returns (string memory) {
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
