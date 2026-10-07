// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {CrucibleTrials} from "../contracts/CrucibleTrials.sol";
import {AlloyRegistry} from "../contracts/AlloyRegistry.sol";
import {MockIdentityRegistry} from "../contracts/mocks/ERC8004Mocks.sol";

/// The golden path against EXISTING deployments — the whole loop a judge can replay
/// on a running chain, including the one step the seed cannot perform: finalize after
/// the skeptic window really closes.
///
///   Phase A (Begin):  fresh agent registers + links an identity; the sponsor lights
///                     two trials; the agent claims and submits runner-signed runs;
///                     a skeptic breaks trial A only.
///   (between:         the operator warps the node past the window — on Anvil any
///                     remote caller may, which is itself part of the demo)
///   Phase B (Finish): Argus overturns A (slashed); the relayer quenches B (paid).
///
///   TRIALS=0x… ALLOY=0x… forge script script/GoldenPath.s.sol:Begin \
///     --rpc-url <anvil> --broadcast
///   cast rpc anvil_setNextBlockTimestamp <now + 2 hours> --rpc-url <anvil>
///   cast rpc anvil_mine 1 --rpc-url <anvil>
///   TRIALS=0x… ALLOY=0x… forge script script/GoldenPath.s.sol:Finish \
///     --rpc-url <anvil> --broadcast
///
/// Every actor is an Anvil genesis account derived from the published dev mnemonic —
/// same rule as Demo.s.sol: the events must land in logs a live reader can quote.
contract GoldenPath is Script {
    string constant DEV_MNEMONIC = "test test test test test test test test test test test junk";
    uint256 constant RUNNER_KEY = 0xB0B; // a runner key distinct from the seed's

    CrucibleTrials internal trials;
    AlloyRegistry internal alloy;
    MockIdentityRegistry internal identity;

    uint256 internal pkArgus1;
    uint256 internal pkArgus2;
    uint256 internal pkOperator;
    uint256 internal pkSponsor;
    uint256 internal pkSkeptic;
    uint256 internal pkRelayer;

    function _wire() internal {
        trials = CrucibleTrials(vm.envAddress("TRIALS"));
        alloy = AlloyRegistry(vm.envAddress("ALLOY"));
        identity = MockIdentityRegistry(trials.identityRegistry());
        pkArgus1 = vm.deriveKey(DEV_MNEMONIC, 1);
        pkArgus2 = vm.deriveKey(DEV_MNEMONIC, 2);
        pkOperator = vm.deriveKey(DEV_MNEMONIC, 9);
        pkSponsor = vm.deriveKey(DEV_MNEMONIC, 6);
        pkSkeptic = vm.deriveKey(DEV_MNEMONIC, 7);
        pkRelayer = vm.deriveKey(DEV_MNEMONIC, 8);
    }

    function _registerAndLink() internal returns (uint256 agentId) {
        vm.broadcast(pkOperator);
        agentId = trials.registerAgent{value: 1 ether}("ipfs://golden-path", vm.addr(RUNNER_KEY));
        vm.broadcast(pkOperator);
        uint256 identityId = identity.register("ipfs://golden-path-identity");
        vm.broadcast(pkOperator);
        trials.linkIdentity(agentId, identityId);
        console.log("agent", agentId, "registered and linked");
    }

    function _post(string memory tag) internal returns (uint256 id) {
        vm.broadcast(pkSponsor);
        id = trials.createTrial{value: 0.5 ether}(
            keccak256(abi.encodePacked("spec:", tag)),
            keccak256(abi.encodePacked("tests:", tag)),
            uint64(block.timestamp + 2 days),
            1 hours
        );
        console.log("trial", id, "posted (0.5 ETH, 1h window)");
    }

    function _claimAndSubmit(uint256 agentId, uint256 id, bytes32 runHash) internal {
        vm.broadcast(pkOperator);
        trials.claimTrial(id);
        _submit(agentId, id, runHash);
    }

    function _submit(uint256 agentId, uint256 id, bytes32 runHash) internal {
        uint64 sigDeadline = uint64(block.timestamp + 12 hours);
        bytes32 structHash = keccak256(abi.encode(trials.RUN_TYPEHASH(), id, agentId, runHash, sigDeadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", trials.DOMAIN(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RUNNER_KEY, digest);
        vm.broadcast(pkRelayer);
        trials.submitRun(id, runHash, abi.encodePacked(r, s, v), sigDeadline);
    }

    function _fileBreak(uint256 id) internal {
        vm.broadcast(pkSkeptic);
        trials.fileBreak{value: 0.01 ether}(id, keccak256("golden-path-break"));
    }

    function _vote(uint256 id, bool breakWins) internal {
        bytes32 salt = keccak256("golden-path-salt");
        bytes32 commitment = keccak256(abi.encodePacked(id, breakWins, salt));
        vm.broadcast(pkArgus1);
        trials.commitVote(id, commitment);
        vm.broadcast(pkArgus2);
        trials.commitVote(id, commitment);
        vm.broadcast(pkArgus1);
        trials.revealVote(id, breakWins, salt);
        vm.broadcast(pkArgus2);
        trials.revealVote(id, breakWins, salt); // 2-of-3 settles
    }

    function _report(uint256 slashed, uint256 paid) internal view {
        console.log("GOLDEN PATH RESULT");
        console.log(
            "  trial",
            slashed,
            "verdict:",
            uint8(trials.getTrial(slashed).verdict) == uint8(CrucibleTrials.Verdict.Slashed)
                ? "slashed (broken)"
                : "UNEXPECTED"
        );
        console.log(
            "  trial",
            paid,
            "verdict:",
            uint8(trials.getTrial(paid).verdict) == uint8(CrucibleTrials.Verdict.Paid)
                ? "paid (verified)"
                : "UNEXPECTED"
        );
        uint256 paidAgent = uint256(trials.getTrial(paid).agentId);
        uint256 slashedAgent = uint256(trials.getTrial(slashed).agentId);
        (uint32 wins, uint32 survived, , ) = alloy.records(paidAgent);
        (, , uint32 scars, ) = alloy.records(slashedAgent);
        console.log("  paid agent: wins", uint256(wins), "survived", uint256(survived));
        console.log("  paid agent tier:", alloy.tierName(paidAgent));
        console.log("  slashed agent: scars", uint256(scars));
    }
}

/// Phase A: everything that must happen while the clock runs honestly.
contract Begin is GoldenPath {
    function run() external {
        _wire();
        uint256 agentId = _registerAndLink();
        uint256 broken = _post("golden-path-broken");
        uint256 quiet = _post("golden-path-quiet");
        _claimAndSubmit(agentId, broken, keccak256("RunArtifact{golden,broken}"));
        _claimAndSubmit(agentId, quiet, keccak256("RunArtifact{golden,quiet}"));
        _fileBreak(broken);
        console.log("PHASE A DONE - warp the node past the window, then run :Finish");
        console.log("  broken trial:", broken);
        console.log("  quiet trial:", quiet);
    }
}

/// Phase B: after the warp — the slash edge and the uncontested quench.
contract Finish is GoldenPath {
    function run() external {
        _wire();
        uint256 broken = uint256(vm.envUint("BROKEN_TRIAL"));
        uint256 quiet = uint256(vm.envUint("QUIET_TRIAL"));
        _vote(broken, true); // 2-of-3: the break lands, the agent is slashed
        vm.broadcast(pkRelayer); // finalize is permissionless; the bystander quenches
        trials.finalize(quiet);
        _report(broken, quiet);
    }
}
