// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {CrucibleTrials} from "../contracts/CrucibleTrials.sol";
import {AlloyRegistry} from "../contracts/AlloyRegistry.sol";
import {MockIdentityRegistry} from "../contracts/mocks/ERC8004Mocks.sol";
import {SeedContent} from "./SeedContent.sol";

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
/// `:Finish` finds the two trials on the chain — the sponsor's last two, checked against the
/// shape each edge needs — so the pair does not have to be remembered between the phases.
/// `BROKEN_TRIAL` and `QUIET_TRIAL` override that when the chain is not quiet; the script
/// refuses a derived pair it cannot identify rather than voting on someone else's trial.
///
/// It runs on a chain from `Deploy.s.sol` as well as the demo chain: the identity registry is
/// the one wire `Deploy` leaves off, and `linkIdentity` is documented (CrucibleTrials.sol:356)
/// as staying permitted-but-unverifiable without it, so `:Begin` links when a registry is
/// wired and says plainly when it is not. The Alloy tier, the slash and the quench all land
/// either way; only the ERC-8004 feedback write is skipped, which is the contract's own
/// fail-closed behaviour, not something this script papers over.
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
        address registry = trials.identityRegistry();
        if (registry == address(0)) {
            console.log("agent", agentId, "registered; no identity registry wired on this chain");
            console.log("  identity left unlinked: Alloy tiers and settlement are unaffected");
            return agentId;
        }
        identity = MockIdentityRegistry(registry);
        vm.broadcast(pkOperator);
        uint256 identityId = identity.register("ipfs://golden-path-identity");
        vm.broadcast(pkOperator);
        trials.linkIdentity(agentId, identityId);
        console.log("agent", agentId, "registered and linked to identity", identityId);
    }

    function _post(string memory tag) internal returns (uint256 id) {
        vm.broadcast(pkSponsor);
        // The demand is the same pinned fixture for both golden paths — what the sponsor asks is
        // "make this suite pass", and the two paths differ in what the agent answers, not in what
        // was asked. The tag stays because it is what the log line and the judge's memory need.
        id = trials.createTrial{value: 0.5 ether}(
            0.5 ether, SeedContent.SPEC_HASH, SeedContent.TESTS_HASH, uint64(block.timestamp + 2 days), 1 hours
        );
        console.log("trial posted:", tag);
        console.log("  id", id, "0.5 ETH, 1h window");
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

    /// Thrown by `_trialPair` when the pair it derived is not the pair `:Begin` lit.
    error WrongTrials();

    /// The pair `:Begin` lit, read back off the chain instead of remembered by the operator.
    ///
    /// `:Finish` is a money action — it casts four Argus transactions and a finalize — so it
    /// will not act on trials it cannot identify. The derivation is the sponsor's last two
    /// trials; the check is what the two edges require, namely the slash target sitting in
    /// `Challenged` (a break was filed) and the quench target in `Judging` (none was), both
    /// owned by this sponsor. A chain that carried somebody else's trial between the phases
    /// fails here with the reason named, rather than voting on the wrong trial and settling it.
    function _trialPair() internal view returns (uint256 broken, uint256 quiet) {
        uint256 count = trials.trialCount();
        uint256 derivedBroken = count >= 2 ? count - 1 : 0;
        uint256 derivedQuiet = count >= 2 ? count : 0;
        broken = vm.envOr("BROKEN_TRIAL", derivedBroken);
        quiet = vm.envOr("QUIET_TRIAL", derivedQuiet);
        CrucibleTrials.Trial memory b = trials.getTrial(broken);
        CrucibleTrials.Trial memory q = trials.getTrial(quiet);
        address sponsor = vm.addr(pkSponsor);
        if (b.sponsor != sponsor || q.sponsor != sponsor) {
            console.log("trials", broken, "and", quiet);
            console.log("are not this sponsor's: pass BROKEN_TRIAL and QUIET_TRIAL for the pair :Begin lit");
            revert WrongTrials();
        }
        if (b.status != CrucibleTrials.Status.Challenged || q.status != CrucibleTrials.Status.Judging) {
            console.log("trial", broken, "status", uint256(uint8(b.status)));
            console.log("trial", quiet, "status", uint256(uint8(q.status)));
            console.log("the slash needs a Challenged trial and the quench a Judging one");
            revert WrongTrials();
        }
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
        (uint32 wins, uint32 survived,,, uint32 epoch,,,,) = alloy.records(paidAgent);
        (,, uint32 scars,,,,,,) = alloy.records(slashedAgent);
        console.log("  paid agent: wins", uint256(wins), "survived", uint256(survived));
        console.log("  paid agent tier:", alloy.tierName(paidAgent));
        console.log("  paid agent epoch", uint256(epoch));
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
        (uint256 broken, uint256 quiet) = _trialPair();
        _vote(broken, true); // 2-of-3: the break lands, the agent is slashed
        vm.broadcast(pkRelayer); // finalize is permissionless; the bystander quenches
        trials.finalize(quiet);
        _report(broken, quiet);
    }
}
