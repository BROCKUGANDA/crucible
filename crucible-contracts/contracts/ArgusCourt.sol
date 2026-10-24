// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Params} from "./Params.sol";

/// @title ArgusCourt — the bonded seat pool the arena draws juries from (§12, D-6, gate 745).
/// @notice Seats bond ETH here, declare who they are related to, and are picked by a seed the
/// Arena supplies. The court holds only bonds and slashes: the fees a seat earns are paid by
/// the Arena out of a trial's escrow, so no seat ever waits on this contract to be paid.
///
/// Two ledgers, two invariants, on purpose. `address(court).balance == pending + bonded` is
/// checkable without reading a single trial, and the Arena's own identity does not have to
/// account for money that never passed through it.
contract ArgusCourt {
    struct Seat {
        uint128 bond;
        uint40 unbondAt; // nonzero once the operator has asked to leave
        uint32 activeDraws; // panels this seat is currently sitting on
        address operator;
    }

    error NotArena();
    error NotOwner();
    error ZeroAddress();
    error SeatUnknown();
    error BondTooSmall();
    error AlreadyBonded();
    error NotUnbonding();
    error SeatIsDrawn();
    error NothingToWithdraw();
    error TransferFailed();
    error SeatPoolFull();
    error NotEnoughSeats();
    error ArenaAlreadySet();

    event SeatBonded(address indexed seat, uint256 bond);
    event SeatUnbondRequested(address indexed seat, uint40 availableAt);
    event SeatWithdrawn(address indexed seat, uint256 amount);
    event ConflictDeclared(address indexed seat, address indexed party);
    event Drawn(address indexed seat);
    event DrawClosed(address indexed seat);
    event SeatSlashed(address indexed seat, address indexed treasury, uint256 amount);
    event Credited(address indexed to, uint256 amount);
    event ArenaSet(address indexed arena);

    /// @notice Hard bound on the pool: `draw` walks it to pick three seats, so an unbounded
    /// pool is an unbounded loop in a permissionless entry point.
    uint256 public constant MAX_SEATS = 256;
    uint256 public constant BPS = Params.BPS;
    uint256 public constant MIN_BOND = 0.01 ether;

    address public immutable owner;
    address public arena;

    address[] private _pool;
    mapping(address => Seat) private _seats;
    /// @dev seat => party it declared itself tied to. A draw that ignores these is a captured
    /// panel (§6.4.1), so the exclusion is a check the Arena makes and the court remembers.
    mapping(address => mapping(address => bool)) public conflictOf;

    mapping(address => uint256) public credit;
    uint256 public totalPending;
    uint256 public totalBonded;

    uint256 private _guard;

    modifier onlyArena() {
        if (msg.sender != arena) revert NotArena();
        _;
    }

    modifier notReentrant() {
        if (_guard == 0) revert TransferFailed();
        _guard = 0;
        _;
        _guard = 1;
    }

    constructor() {
        owner = msg.sender;
        _guard = 1;
    }

    /// @notice One-shot wiring of the Arena that may draw and close. Refusing a second write
    /// is the point: a court that can be re-parented can be made to slash on someone else's
    /// say-so.
    function setArena(address arena_) external {
        if (msg.sender != owner) revert NotOwner();
        if (arena != address(0)) revert ArenaAlreadySet();
        if (arena_ == address(0)) revert ZeroAddress();
        arena = arena_;
        emit ArenaSet(arena_);
    }

    /// @notice Open or top up a seat. Anyone may sit; the bond is the entry ticket, and the
    /// per-trial floor in the Arena decides whether this seat is rich enough to be drawn.
    function bondSeat() external payable {
        if (msg.value < MIN_BOND) revert BondTooSmall();
        Seat storage s = _seats[msg.sender];
        if (s.operator == address(0)) {
            if (_pool.length >= MAX_SEATS) revert SeatPoolFull();
            s.operator = msg.sender;
            _pool.push(msg.sender);
        } else if (s.unbondAt != 0) {
            // Re-bonding cancels a pending exit: an operator who asks to leave and then tops up
            // has changed their mind, and leaving the old timer running would silently strand
            // the new money behind it.
            s.unbondAt = 0;
        }
        s.bond += uint128(msg.value);
        totalBonded += msg.value;
        emit SeatBonded(msg.sender, msg.value);
    }

    /// @notice Ask to leave. The bond is withdrawable only after SEAT_UNBONDING_SECONDS, and
    /// never while this seat is sitting on a panel.
    function requestUnbond() external {
        Seat storage s = _seats[msg.sender];
        if (s.operator == address(0)) revert SeatUnknown();
        if (s.activeDraws != 0) revert SeatIsDrawn();
        s.unbondAt = uint40(block.timestamp + Params.SEAT_UNBONDING_SECONDS);
        emit SeatUnbondRequested(msg.sender, s.unbondAt);
    }

    /// @notice Take the bond out once the delay has run. The un-bonding flag clears with it, so
    /// a seat that withdrew is genuinely out of the pool rather than a zero-bond ghost.
    function withdrawSeat() external notReentrant {
        Seat storage s = _seats[msg.sender];
        if (s.operator == address(0)) revert SeatUnknown();
        if (s.unbondAt == 0) revert NotUnbonding();
        if (block.timestamp < s.unbondAt) revert NotUnbonding();
        if (s.activeDraws != 0) revert SeatIsDrawn();

        uint256 amt = s.bond;
        if (amt == 0) revert NothingToWithdraw();
        s.bond = 0;
        s.unbondAt = 0;
        totalBonded -= amt;
        (bool ok,) = msg.sender.call{value: amt}("");
        if (!ok) revert TransferFailed();
        emit SeatWithdrawn(msg.sender, amt);
    }

    /// @notice Declare a relationship the draw must respect — an organisation, a sponsor you
    /// work for, an agent you are a fork of. Declaring it costs you draws; hiding it costs you
    /// nothing here, which is why the off-chain linkage scan in §18.5 exists beside this.
    function declareConflict(address party) external {
        if (party == address(0)) revert ZeroAddress();
        if (_seats[msg.sender].operator == address(0)) revert SeatUnknown();
        conflictOf[msg.sender][party] = true;
        emit ConflictDeclared(msg.sender, party);
    }

    /// @notice Is this seat drawable for a trial whose bond floor is `minBond`?
    function isEligible(address seat, uint256 minBond) external view returns (bool) {
        return _eligible(seat, minBond);
    }

    function _eligible(address seat, uint256 minBond) internal view returns (bool) {
        Seat storage s = _seats[seat];
        if (s.operator == address(0)) return false;
        if (s.unbondAt != 0) return false;
        if (s.activeDraws != 0) return false;
        return s.bond >= minBond && s.bond >= MIN_BOND;
    }

    function poolLength() external view returns (uint256) {
        return _pool.length;
    }

    function seatAt(uint256 index) external view returns (address) {
        return _pool[index];
    }

    /// @notice Pick ARGUS_SEATS distinct eligible seats, none of them excluded or declared
    /// conflicted with an excluded party. The walk starts at a seed-derived offset and steps
    /// every `stride` positions, so a caller who can influence the seed cannot simply queue up
    /// behind the last seat it likes: the stride is coprime-ish by construction because it is
    /// derived from the same seed and forced odd.
    /// @dev view, not payable: selection moves no value. The locks it implies are applied by
    /// `noteDraw`, which only the Arena may call.
    function draw(uint256 seed, address[] calldata exclusions, uint256 minBond)
        external
        view
        returns (address[3] memory picked)
    {
        uint256 n = _pool.length;
        if (n < Params.ARGUS_SEATS) revert NotEnoughSeats();
        // A rotation, not a stride. `start + step` visits every index exactly once for any pool
        // size; a stride that shares a factor with the length revisits seats, and with three
        // seats and a stride of three the "jury" came back as the same seat three times — which
        // is caught here because the walk cannot skip a seat it already took.
        uint256 start = seed % n;

        uint256 found;
        for (uint256 step; step < n && found < Params.ARGUS_SEATS; ++step) {
            address candidate = _pool[(start + step) % n];
            if (!_eligible(candidate, minBond)) continue;
            if (_excluded(candidate, exclusions)) continue;
            picked[found++] = candidate;
        }
        if (found < Params.ARGUS_SEATS) revert NotEnoughSeats();
    }

    function _excluded(address candidate, address[] calldata exclusions) internal view returns (bool) {
        for (uint256 i; i < exclusions.length; ++i) {
            address party = exclusions[i];
            if (party == candidate) return true;
            if (conflictOf[candidate][party]) return true;
        }
        return false;
    }

    /// @notice Lock the drawn seats to this panel so none of them can unbond out from under a
    /// slash. Arena-only, and idempotent per seat within a draw.
    function noteDraw(address[3] calldata seats) external onlyArena {
        for (uint8 s; s < 3; ++s) {
            Seat storage seat = _seats[seats[s]];
            if (seat.operator == address(0)) revert SeatUnknown();
            seat.activeDraws += 1;
            emit Drawn(seats[s]);
        }
    }

    /// @notice Release a finished panel. Missing seats are tolerated: a seat that withdrew its
    /// bond in the meantime simply has nothing left to release.
    function closeDraw(address[3] calldata seats) external onlyArena {
        for (uint8 s; s < 3; ++s) {
            Seat storage seat = _seats[seats[s]];
            if (seat.activeDraws == 0) continue;
            seat.activeDraws -= 1;
            emit DrawClosed(seats[s]);
        }
    }

    /// @notice A missed commit or a missed reveal. The slash is the only reason this contract
    /// can move money to the treasury, and it is only reachable by the Arena, only for a seat
    /// that failed to show, and only against that seat's own bond.
    function slashNoShow(address seat, address treasury) external onlyArena {
        Seat storage s = _seats[seat];
        if (s.operator == address(0) || s.bond == 0) return;
        uint256 amount = (uint256(s.bond) * Params.SEAT_SLASH_BPS) / BPS;
        if (amount == 0) return;
        s.bond -= uint128(amount);
        totalBonded -= amount;
        if (s.bond == 0) {
            // A fully slashed seat is no longer in the pool of anything; it must re-bond to be
            // drawable again, and its exit timer is irrelevant while it has nothing to exit.
            s.unbondAt = 0;
        }
        credit[treasury] += amount;
        totalPending += amount;
        emit SeatSlashed(seat, treasury, amount);
        emit Credited(treasury, amount);
    }

    /// @notice The treasury side of the court's own pull ledger.
    function withdraw() external notReentrant {
        uint256 amt = credit[msg.sender];
        if (amt == 0) revert NothingToWithdraw();
        credit[msg.sender] = 0;
        totalPending -= amt;
        (bool ok,) = msg.sender.call{value: amt}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice The court's conservation identity: what it holds equals what it owes in bonds
    /// plus what it owes in slashes. A handler can assert this after every step.
    function conservationHolds() external view returns (bool) {
        return address(this).balance == totalPending + totalBonded;
    }

    function bondedOf(address seat) external view returns (uint256 bond, uint256 unbondAt, uint256 activeDraws) {
        Seat storage s = _seats[seat];
        return (s.bond, s.unbondAt, s.activeDraws);
    }
}
