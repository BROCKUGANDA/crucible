// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {CrucibleTrials} from "../contracts/CrucibleTrials.sol";
import {AlloyRegistry} from "../contracts/AlloyRegistry.sol";
import {ReputationBridge} from "../contracts/ReputationBridge.sol";
import {VerificationReceipt} from "../contracts/VerificationReceipt.sol";

/// The signer decision every deployment script in this file shares, so the rule cannot
/// drift between two callers of the same env var.
///
/// It mirrors the keeper's rule (`apps/keeper/src/main.ts`), which already states it in
/// three parts: an explicit `PRIVATE_KEY` is an operator decision and is never second-
/// guessed; the published Anvil key #0 is legitimate ONLY on a chain that reports the
/// local demo id; every other combination refuses.
///
/// Before this, the scripts were the exception. `vm.envOr("PRIVATE_KEY", DEFAULT_PK)`
/// reads as "no key? fine" and silently signs with a private key that is printed in
/// Foundry's own documentation and holds real assets on any chain a stranger has funded.
/// Against `--rpc-url sepolia` that is a deployment anyone could later impersonate, and
/// the chain id in the check is read from the node being broadcast to, not from a config
/// value someone would set to whatever passes the check.
abstract contract DevKeyScript is Script {
    uint256 internal constant LOCAL_ANVIL_CHAIN_ID = 31337;
    /// Anvil's documented account #0. Public knowledge, and the reason it needs a gate.
    uint256 internal constant ANVIL_DEV_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    error NoDeployerKey(uint256 chainid);

    /**
     * Resolve the signing key without ever silently adopting the published one.
     *
     * An explicit `PRIVATE_KEY` wins, exactly as the keeper's rule says. With none set, the
     * Anvil dev key is used only when the operator opts in by name — because the obvious
     * guard here does not work, and a guard that cannot fire is worse than none: measured
     * 2026-10-29 with forge 1.8.5, `forge script --rpc-url <node>` evaluates the script in a
     * local EVM that reports chain id 31337 no matter which node it is pointed at, so
     * `block.chainid` here would be 31337 against Sepolia too. The chain the deployment will
     * actually land on is verified outside, against the node, by `scripts/deploy-network.mjs`.
     *
     * The revert names the variable to set rather than the chain id, because `chainid` is
     * what the operator thinks they are on and the honest answer is "we did not ask the node
     * from in here".
     */
    function signerKey() internal returns (uint256 pk) {
        pk = vm.envOr("PRIVATE_KEY", uint256(0));
        if (pk != 0) {
            return pk;
        }
        if (vm.envOr("ALLOW_ANVIL_DEV_KEY", uint256(0)) != 1) {
            revert NoDeployerKey(block.chainid);
        }
        return ANVIL_DEV_KEY;
    }
}

/// Deploys AlloyRegistry first (its constructor sets `owner` = the deployer), then
/// CrucibleTrials, then closes the circular reference with setForge.
///
/// ERC-8004 wiring is a separate, optional script: `DeployReputation.s.sol`. Reputation
/// is point-in-time and per-chain, so it should be (re)pointable without redeploying
/// the contracts that hold user funds.
contract Deploy is DevKeyScript {
    function run() external returns (CrucibleTrials trials, AlloyRegistry alloy, VerificationReceipt receipt) {
        uint256 pk = signerKey();

        vm.startBroadcast(pk);
        alloy = new AlloyRegistry();
        trials = new CrucibleTrials(vm.addr(pk), address(alloy), _argusSeats());
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
contract DeployReputation is DevKeyScript {
    function run() external returns (ReputationBridge bridge) {
        uint256 pk = signerKey();
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
