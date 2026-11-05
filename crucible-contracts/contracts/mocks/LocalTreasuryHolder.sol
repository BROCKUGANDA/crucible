// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

/// @notice LOCAL TEST STAND-IN for the company treasury Safe.
/// @dev The production deployment (script/Deploy.s.sol) requires the treasury and
/// owner to be contracts with code, and the mainnet preflight pins their Safe
/// runtime bytecode — on a real network that code is a real Safe, deployed by the
/// company and verified on-chain. This contract exists so the local end-to-end
/// (deploy/edge/treasury-reconcile.test.mjs) can exercise the same boundary — a
/// treasury that is a *contract* which must itself call `withdraw()` to move its
/// fee — without shipping Safe's full source into this repository. It is a
/// two-function wallet: it can pull its own credit and sweep to its owner. It is
/// not a multisig, has none of Safe's guards, and must never be deployed anywhere
/// but a local test chain.
interface IPullEscrow {
    function withdraw() external;
}

contract LocalTreasuryHolder {
    address public immutable owner;

    constructor() {
        owner = msg.sender;
    }

    /// Pull whatever credit this holder has earned in the escrow. Anyone may
    /// trigger it; the escrow pays the caller (this contract) and only this
    /// contract's own credit — the same pull-ledger law the Safe obeys.
    function pull(address escrow) external {
        IPullEscrow(escrow).withdraw();
    }

    receive() external payable {}

    /// Move funds out to the owner — the step a Safe would perform through its own
    /// signing threshold.
    function sweep(address payable to, uint256 amount) external {
        require(msg.sender == owner, "LocalTreasuryHolder: not owner");
        (bool ok,) = to.call{value: amount}("");
        require(ok, "LocalTreasuryHolder: sweep failed");
    }
}
