// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {CrucibleTrials} from "../contracts/CrucibleTrials.sol";
import {AlloyRegistry} from "../contracts/AlloyRegistry.sol";
import {ReputationBridge} from "../contracts/ReputationBridge.sol";
import {VerificationReceipt} from "../contracts/VerificationReceipt.sol";

/// Deploys AlloyRegistry first (its constructor sets `owner` = the deployer), then
/// CrucibleTrials, then closes the circular reference with setForge.
///
/// ERC-8004 wiring is a separate, optional script: `DeployReputation.s.sol`. Reputation
/// is point-in-time and per-chain, so it should be (re)pointable without redeploying
/// the contracts that hold user funds.
contract Deploy is Script {
    uint256 internal constant DEFAULT_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function run() external returns (CrucibleTrials trials, AlloyRegistry alloy, VerificationReceipt receipt) {
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(DEFAULT_PK));

        vm.startBroadcast(pk);
        address multisig = vm.envAddress("MULTISIG");
        alloy = new AlloyRegistry();
        trials = new CrucibleTrials(multisig, address(alloy), _argusSeats());
        alloy.setForge(address(trials));

        // VerificationReceipt (gates 415-418): deploy, wire into CrucibleTrials, enable.
        // CrucibleTrials is the minter (it calls mintReceipt inside settleBatch), so the
        // receipt's minter is set to the trials address after both are deployed.
        receipt = new VerificationReceipt();
        receipt.setMinter(address(trials));
        trials.setVerificationReceipt(address(receipt));
        trials.setReceiptsEnabled(true);
        vm.stopBroadcast();

        _report(address(alloy), address(trials));
        console.log("VerificationReceipt", address(receipt));
    }

    /// v1 fixes exactly three Argus seats; 2-of-3 commit-reveal resolves a dispute.
    /// Mainnet seats must be supplied by independently held keys, never development keys.
    function _argusSeats() internal returns (address[] memory seats) {
        seats = new address[](3);
        seats[0] = vm.envAddress("ARGUS_SEAT_1");
        seats[1] = vm.envAddress("ARGUS_SEAT_2");
        seats[2] = vm.envAddress("ARGUS_SEAT_3");
    }

    /// console.log's string+address overloads get their own frame so `run` stays under
    /// the 16-slot stack limit under the legacy codegen.
    function _report(address alloyAddr, address trialsAddr) internal pure {
        console.log("AlloyRegistry", alloyAddr);
        console.log("CrucibleTrials", trialsAddr);
    }
}

/// Wires ERC-8004 reputation onto an existing Crucible deployment.
/// Usage:
///   TRIALS=0x… ERC8004_REPUTATION=0x… forge script script/Deploy.s.sol:DeployReputation \
///     --rpc-url <network> --broadcast
contract DeployReputation is Script {
    uint256 internal constant DEFAULT_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function run() external returns (ReputationBridge bridge) {
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(DEFAULT_PK));
        CrucibleTrials trials = CrucibleTrials(vm.envAddress("TRIALS"));
        address registry = vm.envOr("ERC8004_REPUTATION", address(0));

        vm.startBroadcast(pk);
        bridge = new ReputationBridge(address(trials));
        if (registry != address(0)) {
            bridge.setReputationRegistry(registry);
        }
        trials.setReputationBridge(address(bridge));
        vm.stopBroadcast();

        console.log("ReputationBridge", address(bridge));
        if (registry == address(0)) {
            // Not an error: reputation is the only path here that is allowed to fail
            // closed. Settlements work either way; wire a registry later to turn
            // reputation on.
            console.log("reputationRegistry  unwired");
            console.log("  settlements are unaffected; wire one later with setReputationRegistry");
        } else {
            console.log("reputationRegistry", registry);
        }
    }
}
