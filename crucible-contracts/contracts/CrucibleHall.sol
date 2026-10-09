// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title CrucibleHall — on-chain hall of settled trials.
/// @notice Ported from the merged Scaffold-ETH 2 build (packages/hardhat/contracts/
/// CrucibleHall.sol) with the pragma pinned to this project's solc. It answers a
/// question the indexer cannot: what does the Hall look like to a reader with no
/// API, no database and no server — only a chain? Two primitives make a row
/// provable: an account links a unique handle to its address, and a settler
/// finalizes a staked attempt with a score.
///
/// Every mutation emits an event so an off-chain index can rebuild the snapshot
/// purely from logs. Writes are idempotent where replay is plausible: re-linking
/// the same handle is a no-op, and a settled trial can never be settled twice.
contract CrucibleHall {
    address public immutable owner;

    uint256 public constant MIN_STAKE = 0.001 ether;
    /// @notice Bonus paid on top of a stake when the contract can cover it (5000 = +50%).
    uint256 public constant REWARD_BPS = 5000;
    uint256 public constant MAX_HANDLE_BYTES = 24;

    struct Identity {
        string handle;
        uint64 linkedAt;
        uint64 updatedAt;
    }

    struct Trial {
        address settler;
        address contestant;
        uint64 openedAt;
        uint64 settledAt;
        bool settled;
        uint256 stake;
        uint256 score;
        uint256 reward;
    }

    mapping(address => Identity) private _identities;
    mapping(bytes32 => address) private _handleOwner;
    /**
     * Linkage is a bool, not a timestamp sentinel. `linkedAt == 0` doubles as
     * "never linked" in code but reads as a dangerous strict equality to a
     * reviewer and to slither — and a zero timestamp is indistinguishable from
     * a missing one. The bool says the thing it means.
     */
    mapping(address => bool) private _linked;
    mapping(uint256 => Trial) private _trials;
    mapping(address => uint256[]) private _trialsByContestant;

    uint256 public trialCount;
    bool private _settling;

    event IdentityLinked(address indexed account, string handle, uint64 at);
    event IdentityUpdated(address indexed account, string previousHandle, string newHandle, uint64 at);
    event TrialOpened(
        uint256 indexed trialId,
        address indexed settler,
        address indexed contestant,
        uint256 stake,
        uint64 at
    );
    event TrialSettled(uint256 indexed trialId, address indexed contestant, uint256 score, uint256 reward, uint64 at);

    error ZeroAddress();
    error EmptyHandle();
    error HandleTooLong();
    error InvalidHandleCharacter(uint256 index);
    error HandleAlreadyTaken(address holder);
    error NoIdentity(address account);
    error StakeTooLow(uint256 minimum);
    error TrialNotFound(uint256 trialId);
    error TrialAlreadySettled(uint256 trialId);
    error NotAuthorized(address caller);
    error Reentrancy();
    error PayoutFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotAuthorized(msg.sender);
        _;
    }

    modifier nonReentrant() {
        if (_settling) revert Reentrancy();
        _settling = true;
        _;
        _settling = false;
    }

    constructor(address _owner) {
        if (_owner == address(0)) revert ZeroAddress();
        owner = _owner;
    }

    // ─────────────────────────── identity ───────────────────────────

    /**
     * @notice Link a unique handle to msg.sender. Re-linking the identical
     *         handle is a no-op (idempotent replay), switching to a free handle
     *         updates the record and releases the old one.
     */
    function linkIdentity(string calldata handle) external {
        bytes memory raw = bytes(handle);
        uint256 len = raw.length;
        if (len == 0) revert EmptyHandle();
        if (len > MAX_HANDLE_BYTES) revert HandleTooLong();

        for (uint256 i = 0; i < len; ) {
            bytes1 c = raw[i];
            bool allowed = (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || c == 0x5f || c == 0x2d;
            if (!allowed) revert InvalidHandleCharacter(i);
            unchecked {
                ++i;
            }
        }

        bytes32 key = keccak256(raw);
        address holder = _handleOwner[key];
        Identity storage identity = _identities[msg.sender];

        // Replay of the same handle: nothing to do, nothing to emit.
        if (_linked[msg.sender] && keccak256(bytes(identity.handle)) == key) {
            return;
        }

        if (holder != address(0) && holder != msg.sender) revert HandleAlreadyTaken(holder);

        if (!_linked[msg.sender]) {
            _identities[msg.sender] = Identity({
                handle: handle,
                linkedAt: uint64(block.timestamp),
                updatedAt: uint64(block.timestamp)
            });
            _handleOwner[key] = msg.sender;
            _linked[msg.sender] = true;
            emit IdentityLinked(msg.sender, handle, uint64(block.timestamp));
            return;
        }

        string memory previous = identity.handle;
        delete _handleOwner[keccak256(bytes(previous))];
        identity.handle = handle;
        identity.updatedAt = uint64(block.timestamp);
        _handleOwner[key] = msg.sender;
        emit IdentityUpdated(msg.sender, previous, handle, uint64(block.timestamp));
    }

    // ─────────────────────────── trials ───────────────────────────

    /**
     * @notice Open a staked trial for a contestant. The contestant must have
     *         linked an identity so every hall row is provably owned.
     */
    function openTrial(address contestant) external payable returns (uint256 trialId) {
        if (contestant == address(0)) revert ZeroAddress();
        if (!_linked[contestant]) revert NoIdentity(contestant);
        if (msg.value < MIN_STAKE) revert StakeTooLow(MIN_STAKE);

        trialId = ++trialCount;
        _trials[trialId] = Trial({
            settler: msg.sender,
            contestant: contestant,
            openedAt: uint64(block.timestamp),
            settledAt: 0,
            settled: false,
            stake: msg.value,
            score: 0,
            reward: 0
        });
        _trialsByContestant[contestant].push(trialId);

        emit TrialOpened(trialId, msg.sender, contestant, msg.value, uint64(block.timestamp));
    }

    /**
     * @notice Settle a trial with a final score and pay the contestant.
     *         State flips before the external call (checks-effects-interactions),
     *         re-entry and double settlement are both rejected.
     */
    function settleTrial(uint256 trialId, uint256 score) external nonReentrant returns (uint256 reward) {
        Trial storage trial = _trials[trialId];
        if (trial.openedAt == 0) revert TrialNotFound(trialId);
        if (trial.settled) revert TrialAlreadySettled(trialId);
        if (msg.sender != owner && msg.sender != trial.settler) revert NotAuthorized(msg.sender);

        trial.settled = true;
        trial.score = score;
        trial.settledAt = uint64(block.timestamp);

        reward = trial.stake + (trial.stake * REWARD_BPS) / 10000;
        uint256 balance = address(this).balance;
        if (reward > balance) reward = balance;
        trial.reward = reward;

        if (reward > 0) {
            (bool ok, ) = payable(trial.contestant).call{value: reward}("");
            if (!ok) revert PayoutFailed();
        }

        emit TrialSettled(trialId, trial.contestant, score, reward, uint64(block.timestamp));
    }

    // ─────────────────────────── views ───────────────────────────

    function identityOf(address account)
        external
        view
        returns (string memory handle, uint64 linkedAt, uint64 updatedAt)
    {
        Identity storage identity = _identities[account];
        return (identity.handle, identity.linkedAt, identity.updatedAt);
    }

    function addressOfHandle(string calldata handle) external view returns (address) {
        return _handleOwner[keccak256(bytes(handle))];
    }

    function trialOf(uint256 trialId) external view returns (Trial memory) {
        return _trials[trialId];
    }

    function trialsOf(address contestant) external view returns (uint256[] memory) {
        return _trialsByContestant[contestant];
    }

    function isSettled(uint256 trialId) external view returns (bool) {
        return _trials[trialId].settled;
    }

    /// @notice Accepts house funding so settleTrial can pay bonuses.
    receive() external payable {}
}
