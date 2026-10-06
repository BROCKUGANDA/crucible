// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {CrucibleTrials} from "../contracts/CrucibleTrials.sol";
import {AlloyRegistry} from "../contracts/AlloyRegistry.sol";
import {ReputationBridge} from "../contracts/ReputationBridge.sol";

/// Deploys AlloyRegistry first (its constructor sets `owner` = the deployer), then
/// CrucibleTrials, then closes the circular reference with setForge.
///
/// ERC-8004 wiring is a separate, optional script: `DeployReputation.s.sol`. Reputation
/// is point-in-time and per-chain, so it should be (re)pointable without redeploying
/// the contracts that hold user funds.
contract Deploy is Script {
    uint256 internal constant DEFAULT_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function run() external returns (CrucibleTrials trials, AlloyRegistry alloy) {
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(DEFAULT_PK));

        vm.startBroadcast(pk);
        alloy = new AlloyRegistry();
        trials = new CrucibleTrials(vm.addr(pk), address(alloy), _argusSeats());
        alloy.setForge(address(trials));
        vm.stopBroadcast();

        _report(address(alloy), address(trials));
    }

    /// v1 fixes exactly three Argus seats; 2-of-3 commit-reveal resolves a dispute.
    /// Anvil accounts 1-3.
    function _argusSeats() internal returns (address[] memory seats) {
        seats = new address[](3);
        seats[0] = vm.addr(0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d);
        seats[1] = vm.addr(0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a);
        seats[2] = vm.addr(0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6);
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
        console.log("reputationRegistry", registry == address(0) ? "unwired" : registry);
        if (registry == address(0)) {
            console.log("settlements are unaffected; wire a registry later with setReputationRegistry");
        }
    }
}
