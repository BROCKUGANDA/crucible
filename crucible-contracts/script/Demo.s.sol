// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {CrucibleTrials} from "../contracts/CrucibleTrials.sol";
import {AlloyRegistry} from "../contracts/AlloyRegistry.sol";
import {MockIdentityRegistry, MockReputationRegistry} from "../contracts/mocks/ERC8004Mocks.sol";
import {ReputationBridge} from "../contracts/ReputationBridge.sol";
import {VerificationReceipt} from "../contracts/VerificationReceipt.sol";
import {SeedContent} from "./SeedContent.sol";

/// Replays the full Crucible loop locally and LEAVES IT ON THE CHAIN — stage insurance.
///   anvil                          # terminal 1
///   forge script script/Demo.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
///
/// @dev Every actor is an Anvil genesis account, keyed by deriving from the published
/// dev mnemonic rather than by `makeAddr` + `prank`. Those cheatcodes only exist in the
/// EVM that `forge test` builds; against an RPC they silently do nothing to the sender,
/// so the previous version of this script "replayed the loop" in a simulation that never
/// reached the node, and the indexer downstream found an empty chain. Deriving real keys
/// is what makes this broadcast: the events land in logs an `/hall` reader can quote.
///
/// Ends with a Hall of Alloy that is provable: two agents with settled trials, both
/// linked to an ERC-8004 identity, one of them carrying a slash so the leaderboard ranks
/// instead of merely counting.
contract Demo is Script {
    /// Anvil's published development mnemonic. Not a secret: every account it derives is
    /// publicly known, which is exactly why the funds in them are worthless.
    string constant DEV_MNEMONIC = "test test test test test test test test test test test junk";

    /// The runner's signing key. Never funds a transaction — it only signs EIP-712
    /// digests — so a synthetic key is the honest choice here.
    uint256 constant RUNNER_KEY = 0xA11CE;

    CrucibleTrials internal trials;
    AlloyRegistry internal alloy;
    MockIdentityRegistry internal identity;
    MockReputationRegistry internal reputation;
    ReputationBridge internal bridge;

    uint256 internal pkDeployer;
    uint256 internal pkArgus1;
    uint256 internal pkArgus2;
    uint256 internal pkArgus3;
    uint256 internal pkOperatorA;
    uint256 internal pkOperatorB;
    uint256 internal pkSponsor;
    uint256 internal pkSkeptic;
    uint256 internal pkRelayer;

    function run() external {
        _keyActors();

        vm.startBroadcast(pkDeployer);
        identity = new MockIdentityRegistry();
        alloy = _deployTrials(payable(vm.addr(pkDeployer)));
        trials.setIdentityRegistry(address(identity));
        _wireReputation();
        vm.stopBroadcast();

        console.log("CrucibleTrials", address(trials));
        console.log("AlloyRegistry", address(alloy));
        console.log("IdentityRegistry(mock)", address(identity));

        console.log("1. two operators, four trials");
        uint256 agentA = _forgeAgent(pkOperatorA, "ipfs://manifestA");
        uint256 agentB = _forgeAgent(pkOperatorB, "ipfs://manifestB");

        // The identity links come BEFORE the trials, not after them. The bridge resolves the
        // ERC-8004 subject at settlement, so an agent that is unlinked when its verdict lands
        // publishes nothing but a `FeedbackSkipped` — and the one-call aggregate below would
        // then read zero across four settled trials: a getter that works, over a deployment
        // that never filled it. Ordering is the whole difference between those two states.
        console.log("2. identity links");
        uint256 identityA = _linkIdentity(agentA, pkOperatorA, "ipfs://identityA");
        uint256 identityB = _linkIdentity(agentB, pkOperatorB, "ipfs://identityB");
        // The mock's own registration step. A real ERC-8004 registry learns about an agent from
        // the Identity Registry it is paired with; this double keeps a separate `agentRegistered`
        // map, so the seed has to say it here or `giveFeedback` refuses every write as
        // `AgentNotRegistered`. This is the seam where the double differs from the standard, and
        // it is named rather than hidden.
        vm.broadcast(pkDeployer);
        reputation.setAgent(identityA, vm.addr(pkOperatorA), false);
        vm.broadcast(pkDeployer);
        reputation.setAgent(identityB, vm.addr(pkOperatorB), false);

        // Every trial here settles through an Argus vote, which needs no clock travel and
        // therefore produces the same chain on a fresh Anvil and a week-old one.
        //
        // The spec and suite digests are pinned content, so a skeptic who claimed one of these
        // could fetch the bytes behind both hashes and re-run the suite. They share one fixture
        // rather than carrying four: the four rows differ by what the agents claimed and how it
        // settled, not by what was asked of them, and four `keccak256("spec-N")` values named
        // content that was never anywhere.
        //
        // NOT pinned here: the run hashes below (`RunArtifact{...}`). Those are the agent's
        // submission, and a real one comes from the runner signing real bytes — see
        // scripts/verify-roundtrip.mjs. A demo hall therefore has resolvable demands and
        // synthetic answers, which is the honest state until a run is published per trial.
        console.log("3. four trials, settled");
        _paidWithstand(agentA, pkOperatorA, SeedContent.SPEC_HASH, SeedContent.TESTS_HASH, 1 ether);
        _paidWithstand(agentB, pkOperatorB, SeedContent.SPEC_HASH, SeedContent.TESTS_HASH, 1 ether);
        _slashed(agentB, pkOperatorB, SeedContent.SPEC_HASH, SeedContent.TESTS_HASH, 1 ether);
        _paidWithstand(agentA, pkOperatorA, SeedContent.SPEC_HASH, SeedContent.TESTS_HASH, 1 ether);

        _report(agentA, agentB, identityA, identityB);
    }

    /// Derives every actor from the dev mnemonic and refuses to continue if any of them
    /// is not a funded account on the node being driven. Without this, a non-Anvil RPC
    /// fails on the first transfer with an out-of-gas/insufficient-balance error that
    /// names a hex address rather than the role that is missing.
    function _keyActors() internal {
        pkDeployer = vm.deriveKey(DEV_MNEMONIC, 0);
        pkArgus1 = vm.deriveKey(DEV_MNEMONIC, 1);
        pkArgus2 = vm.deriveKey(DEV_MNEMONIC, 2);
        pkArgus3 = vm.deriveKey(DEV_MNEMONIC, 3);
        pkOperatorA = vm.deriveKey(DEV_MNEMONIC, 4);
        pkOperatorB = vm.deriveKey(DEV_MNEMONIC, 5);
        pkSponsor = vm.deriveKey(DEV_MNEMONIC, 6);
        pkSkeptic = vm.deriveKey(DEV_MNEMONIC, 7);
        pkRelayer = vm.deriveKey(DEV_MNEMONIC, 8);

        address[] memory funded = new address[](8);
        funded[0] = vm.addr(pkDeployer);
        funded[1] = vm.addr(pkArgus1);
        funded[2] = vm.addr(pkArgus2);
        funded[3] = vm.addr(pkArgus3);
        funded[4] = vm.addr(pkOperatorA);
        funded[5] = vm.addr(pkOperatorB);
        funded[6] = vm.addr(pkSponsor);
        funded[7] = vm.addr(pkSkeptic);

        for (uint256 i; i < funded.length; ++i) {
            require(funded[i].balance > 2 ether, "not a funded anvil account");
        }
    }

    /// Deployed in its own frame: the constructor's five words plus the alloy wiring
    /// overflow the legacy codegen's 16 slots when they share a frame with the loop.
    function _deployTrials(address treasury) internal returns (AlloyRegistry alloyRegistry) {
        address[] memory seats = new address[](3);
        seats[0] = vm.addr(pkArgus1);
        seats[1] = vm.addr(pkArgus2);
        seats[2] = vm.addr(pkArgus3);
        alloyRegistry = new AlloyRegistry();
        trials = new CrucibleTrials(treasury, address(alloyRegistry), seats);
        alloyRegistry.setForge(address(trials));

        // VerificationReceipt (gates 415-418): deploy, wire into CrucibleTrials, enable.
        VerificationReceipt receipt = new VerificationReceipt();
        receipt.setMinter(address(trials));
        trials.setVerificationReceipt(address(receipt));
        trials.setReceiptsEnabled(true);
        console.log("VerificationReceipt", address(receipt));
    }

    function _forgeAgent(uint256 pk, string memory metadataURI) internal returns (uint256 agentId) {
        vm.broadcast(pk);
        agentId = trials.registerAgent{value: 1 ether}(metadataURI, vm.addr(RUNNER_KEY));
    }

    /// Lights a trial and has `agentId` claim and submit a signed run for it.
    function _claimAndSubmit(
        uint256 agentId,
        uint256 operatorPk,
        bytes32 spec,
        bytes32 tests,
        bytes32 runHash,
        uint256 reward
    ) internal returns (uint256 id) {
        vm.broadcast(pkSponsor);
        id = trials.createTrial{value: reward}(reward, spec, tests, uint64(block.timestamp + 30 days), 12 hours);

        vm.broadcast(operatorPk);
        trials.claimTrial(id);

        _submit(agentId, id, runHash);
    }

    /// The digest and the signature are built in a second frame: four live values plus
    /// the three-slot tuple `vm.sign` returns do not fit alongside the trial.
    function _submit(uint256 agentId, uint256 id, bytes32 runHash) internal {
        uint64 sigDeadline = uint64(block.timestamp + 12 hours);
        bytes32 structHash = keccak256(abi.encode(trials.RUN_TYPEHASH(), id, agentId, runHash, sigDeadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", trials.DOMAIN(), structHash));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RUNNER_KEY, digest);
        vm.broadcast(pkRelayer); // relay is permissionless — anyone may carry the run
        trials.submitRun(id, runHash, abi.encodePacked(r, s, v), sigDeadline);
    }

    /// A skeptic attacks and loses: this is what turns a win into a *survived* win.
    function _paidWithstand(uint256 agentId, uint256 operatorPk, bytes32 spec, bytes32 tests, uint256 reward) internal {
        uint256 id = _claimAndSubmit(agentId, operatorPk, spec, tests, keccak256("RunArtifact{all-pass}"), reward);
        _fileBreak(id, keccak256("no-proof"), reward);
        _vote(id, false);
    }

    /// Nobody attacks; the window closes and silence settles it as acceptance.
    /// Nobody attacks; the window closes and silence settles it as acceptance.
    ///
    /// Not used by the seed. `finalize` needs the node's clock past `runAt + breakWindow`,
    /// and `vm.warp` moves the *next mined block* while the check below runs against a
    /// timestamp the script cannot see in advance — so it passed on a node that had been
    /// left running for hours and reverted on a fresh one. The path is covered by
    /// `test_Finalize_*` in the contract suite; a demo that only works on a stale chain is
    /// worse than one that skips it.
    function _paidUncontested(uint256 agentId, uint256 operatorPk, bytes32 spec, bytes32 tests, uint256 reward)
        internal
    {
        uint256 id = _claimAndSubmit(agentId, operatorPk, spec, tests, keccak256("RunArtifact{quiet}"), reward);
        vm.warp(block.timestamp + 2 days);
        vm.broadcast(pkRelayer); // finalize is permissionless; the relayer is the bystander
        trials.finalize(id);
    }

    /// The break lands. The hall has to prove a loss with the same rigour as a win, so
    /// this settles slashed rather than being quietly left out of the seed.
    function _slashed(uint256 agentId, uint256 operatorPk, bytes32 spec, bytes32 tests, uint256 reward) internal {
        uint256 id = _claimAndSubmit(agentId, operatorPk, spec, tests, keccak256("RunArtifact{fails-suite}"), reward);
        _fileBreak(id, keccak256("reproduced-the-failure"), reward);
        _vote(id, true);
    }

    function _fileBreak(uint256 id, bytes32 proofCID, uint256 reward) internal {
        vm.broadcast(pkSkeptic);
        trials.fileBreak{value: reward / 100}(id, proofCID);
    }

    function _vote(uint256 id, bool breakWins) internal {
        bytes32 salt = keccak256("salt");
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

    /// The operator registers their own ERC-8004 identity — Crucible cannot, because the
    /// registry mints to the caller — then records the tokenId against the agent.
    function _linkIdentity(uint256 agentId, uint256 operatorPk, string memory uri)
        internal
        returns (uint256 identityAgentId)
    {
        vm.broadcast(operatorPk);
        identityAgentId = identity.register(uri);

        vm.broadcast(operatorPk);
        trials.linkIdentity(agentId, identityAgentId);
        console.log("  agent", agentId, "-> identity", identityAgentId);
    }

    /// The ERC-8004 plumbing, in its own frame like the rest of the deployment.
    ///
    /// Before this the demo chain had `reputationBridge() == address(0)`: the bridge, its tests
    /// and the registry's `getSummary` all existed, and nothing on the box that serves the public
    /// site connected them. So the honest reading of "publish to the reputation registry, and let
    /// an application read the record in one call" was that the *code* did it and the
    /// *deployment* did not — which is the difference this function closes, and the reason the
    /// summary is printed below rather than asserted in prose.
    function _wireReputation() internal {
        reputation = new MockReputationRegistry();
        reputation.initialize(address(identity));
        bridge = new ReputationBridge(address(trials));
        bridge.setReputationRegistry(address(reputation));
        trials.setReputationBridge(address(bridge));
        console.log("ReputationRegistry(mock)", address(reputation));
        console.log("ReputationBridge", address(bridge));
    }

    /// Kept out of `run` for the same reason as the deployment: two live agent records
    /// plus four alloy reads exceed the stack ceiling in one frame.
    function _report(uint256 agentA, uint256 agentB, uint256 identityA, uint256 identityB) internal {
        (uint32 winsA, uint32 survivedA, uint32 slashesA,, uint32 epochA,,,,) = alloy.records(agentA);
        (uint32 winsB, uint32 survivedB, uint32 slashesB,, uint32 epochB,,,,) = alloy.records(agentB);
        console.log("4. hall state on chain");
        console.log("  agent 1 wins", uint256(winsA), "survived", uint256(survivedA));
        console.log("  agent 1 scars", uint256(slashesA), "tier", alloy.tierName(agentA));
        console.log("  agent 1 epoch", uint256(epochA));
        console.log("  agent 2 wins", uint256(winsB), "survived", uint256(survivedB));
        console.log("  agent 2 scars", uint256(slashesB), "tier", alloy.tierName(agentB));
        console.log("  agent 2 epoch", uint256(epochB));
        console.log("  identity 1", trials.identityOf(agentA));
        console.log("  identity 2", trials.identityOf(agentB));
        _reportSummary(identityA, identityB);
    }

    /// @dev The standard's own read, against the standard's own registry shape, on the chain the
    /// site narrates: one call, every write this deployment made about that agent. A hiring
    /// application needs no Crucible endpoint to answer "is this record good" — it needs this
    /// signature and the two addresses `deployed.env` publishes.
    function _reportSummary(uint256 identityA, uint256 identityB) internal view {
        address[] memory clients = new address[](1);
        clients[0] = address(bridge);

        (uint64 countA, int128 valueA,) = reputation.getSummary(identityA, clients, "crucible", "");
        (uint64 countB, int128 valueB,) = reputation.getSummary(identityB, clients, "crucible", "");
        console.log("5. one-call ERC-8004 summary (getSummary, via the bridge as client)");
        console.log("  identity", identityA, "writes", uint256(countA));
        console.log("    aggregate value", int256(valueA));
        console.log("  identity", identityB, "writes", uint256(countB));
        console.log("    aggregate value", int256(valueB));
    }
}
