// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {CrucibleTrials} from "../contracts/CrucibleTrials.sol";
import {AlloyRegistry} from "../contracts/AlloyRegistry.sol";
import {MockIdentityRegistry} from "../contracts/mocks/ERC8004Mocks.sol";

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
        vm.stopBroadcast();

        console.log("CrucibleTrials", address(trials));
        console.log("AlloyRegistry", address(alloy));
        console.log("IdentityRegistry(mock)", address(identity));

        console.log("1. two operators, four trials");
        uint256 agentA = _forgeAgent(pkOperatorA, "ipfs://manifestA");
        uint256 agentB = _forgeAgent(pkOperatorB, "ipfs://manifestB");

        // The uncontested trial runs last: settling it needs the clock pushed past the
        // break window, and a warped node timestamp is a moving reference for every
        // signature deadline computed after it.
        _paidWithstand(agentA, pkOperatorA, keccak256("spec-1"), keccak256("tests-1"));
        _paidWithstand(agentB, pkOperatorB, keccak256("spec-2"), keccak256("tests-2"));
        _slashed(agentB, pkOperatorB, keccak256("spec-3"), keccak256("tests-3"));
        _paidUncontested(agentA, pkOperatorA, keccak256("spec-4"), keccak256("tests-4"));

        console.log("2. identity links");
        _linkIdentity(agentA, pkOperatorA, "ipfs://identityA");
        _linkIdentity(agentB, pkOperatorB, "ipfs://identityB");

        _report(agentA, agentB);
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
    }

    function _forgeAgent(uint256 pk, string memory metadataURI) internal returns (uint256 agentId) {
        vm.broadcast(pk);
        agentId = trials.registerAgent{value: 1 ether}(metadataURI, vm.addr(RUNNER_KEY));
    }

    /// Lights a trial and has `agentId` claim and submit a signed run for it.
    function _claimAndSubmit(uint256 agentId, uint256 operatorPk, bytes32 spec, bytes32 tests, bytes32 runHash)
        internal
        returns (uint256 id)
    {
        vm.broadcast(pkSponsor);
        id = trials.createTrial{value: 1 ether}(spec, tests, uint64(block.timestamp + 30 days), 12 hours);

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
    function _paidWithstand(uint256 agentId, uint256 operatorPk, bytes32 spec, bytes32 tests) internal {
        uint256 id = _claimAndSubmit(agentId, operatorPk, spec, tests, keccak256("RunArtifact{all-pass}"));
        _fileBreak(id, keccak256("no-proof"));
        _vote(id, false);
    }

    /// Nobody attacks; the window closes and silence settles it as acceptance.
    function _paidUncontested(uint256 agentId, uint256 operatorPk, bytes32 spec, bytes32 tests) internal {
        uint256 id = _claimAndSubmit(agentId, operatorPk, spec, tests, keccak256("RunArtifact{quiet}"));
        // Past the deadline for the *stored* runAt, which is the mined timestamp and can
        // sit hours behind the one the script reads. Two days clears the 12-hour window
        // whatever the wall clock did between the two transactions.
        vm.warp(block.timestamp + 2 days);
        vm.broadcast(pkRelayer); // finalize is permissionless; the relayer is the bystander
        trials.finalize(id);
    }

    /// The break lands. The hall has to prove a loss with the same rigour as a win, so
    /// this settles slashed rather than being quietly left out of the seed.
    function _slashed(uint256 agentId, uint256 operatorPk, bytes32 spec, bytes32 tests) internal {
        uint256 id = _claimAndSubmit(agentId, operatorPk, spec, tests, keccak256("RunArtifact{fails-suite}"));
        _fileBreak(id, keccak256("reproduced-the-failure"));
        _vote(id, true);
    }

    function _fileBreak(uint256 id, bytes32 proofCID) internal {
        vm.broadcast(pkSkeptic);
        trials.fileBreak{value: 0.01 ether}(id, proofCID);
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
    function _linkIdentity(uint256 agentId, uint256 operatorPk, string memory uri) internal {
        vm.broadcast(operatorPk);
        uint256 identityAgentId = identity.register(uri);

        vm.broadcast(operatorPk);
        trials.linkIdentity(agentId, identityAgentId);
        console.log("  agent", agentId, "-> identity", identityAgentId);
    }

    /// Kept out of `run` for the same reason as the deployment: two live agent records
    /// plus four alloy reads exceed the stack ceiling in one frame.
    function _report(uint256 agentA, uint256 agentB) internal {
        (uint32 winsA, uint32 survivedA, uint32 slashesA, ) = alloy.records(agentA);
        (uint32 winsB, uint32 survivedB, uint32 slashesB, ) = alloy.records(agentB);
        console.log("3. hall state on chain");
        console.log("  agent 1 wins", uint256(winsA), "survived", uint256(survivedA));
        console.log("  agent 1 scars", uint256(slashesA), "tier", alloy.tierName(agentA));
        console.log("  agent 2 wins", uint256(winsB), "survived", uint256(survivedB));
        console.log("  agent 2 scars", uint256(slashesB), "tier", alloy.tierName(agentB));
        console.log("  identity 1", trials.identityOf(agentA));
        console.log("  identity 2", trials.identityOf(agentB));
    }
}
