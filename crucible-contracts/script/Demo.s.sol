// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {CrucibleTrials} from "../contracts/CrucibleTrials.sol";
import {Arena} from "../contracts/Arena.sol";
import {ArgusCourt} from "../contracts/ArgusCourt.sol";
import {Params} from "../contracts/Params.sol";
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

    /// The attestor that vouches a run passed. A local key, wired by `setAttestor` in the arena
    /// demo frame; the real one is an operator key that never reaches this repository.
    uint256 constant ATTESTOR_KEY = 0xA77E5;

    /// What each demo seat posts. The Arena's per-trial floor is
    /// `reward * SEAT_FEE_BPS/BPS * MAX_DOCKET * SEAT_BOND_MIN_MULTIPLE` — 0.2 × reward for this
    /// parameter set — and that contract number still decides every draw. This is only what the
    /// demo chooses to post; 1 ether clears the floor for any demo trial up to 5 ether.
    uint256 constant SEAT_BOND = 1 ether;

    /// The reward on the one Arena trial the demo posts. It exists so the seat-bond floor is
    /// measured against a real trial rather than against a number in a comment.
    uint256 constant ARENA_TRIAL_REWARD = 0.5 ether;

    CrucibleTrials internal trials;
    AlloyRegistry internal alloy;
    Arena internal arena;
    ArgusCourt internal court;
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
    /// Seats four to six of the v2 arena. The court needs six, not three: `Arena._exclusions`
    /// adds all three round-1 seats to round 2's exclusion list, so a three-seat pool leaves
    /// nothing drawable for round 2 and reverts `NotEnoughSeats` — and O8 with it.
    uint256 internal pkSeat4;
    uint256 internal pkSeat5;
    uint256 internal pkSeat6;

    function run() external {
        _keyActors();

        vm.startBroadcast(pkDeployer);
        identity = new MockIdentityRegistry();
        alloy = _deployTrials(payable(vm.addr(pkDeployer)));
        trials.setIdentityRegistry(address(identity));
        _wireReputation();
        vm.stopBroadcast();

        _deployArena(payable(vm.addr(pkDeployer)));

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
        pkSeat4 = vm.deriveKey(DEV_MNEMONIC, 9);
        pkSeat5 = vm.deriveKey(DEV_MNEMONIC, 10);
        pkSeat6 = vm.deriveKey(DEV_MNEMONIC, 11);

        address[] memory funded = new address[](9);
        funded[0] = vm.addr(pkDeployer);
        funded[1] = vm.addr(pkArgus1);
        funded[2] = vm.addr(pkArgus2);
        funded[3] = vm.addr(pkArgus3);
        funded[4] = vm.addr(pkOperatorA);
        funded[5] = vm.addr(pkOperatorB);
        funded[6] = vm.addr(pkSponsor);
        funded[7] = vm.addr(pkSkeptic);
        funded[8] = vm.addr(pkRelayer);

        // Seats four to six derive past anvil's ten funded genesis accounts, so they start empty
        // and are funded from the deployer in `_deployArena`. `vm.deal` is a cheatcode: against an
        // RPC it does nothing to the sender, which is the same trap the header records.
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

    /// The v2 arena, and the six seats that make its panels drawable.
    ///
    /// Six, not three. `Arena._exclusions` excludes the sponsor, the agent, every skeptic on the
    /// docket, and — from round 2 — all three seats that sat in round 1. With only three bonded,
    /// round 1 consumes the pool and round 2 reverts `NotEnoughSeats`, taking O8 (the no-quorum
    /// refund) with it. The proof below is the court's own `draw`, which is the same call
    /// `drawPanel` makes, so it tests the number that will actually gate a panel.
    ///
    /// The seats are distinct wallets from the sponsor, the agents and the skeptic: a seat that is
    /// any of those is excluded from the draw, shrinking the pool by one exactly on the trial that
    /// matters.
    ///
    /// Keys are derived ONLY on Anvil. The dev mnemonic is published, so these keys are public —
    /// fine on a local chain whose funds are worthless, and a griefing surface anywhere else. Any
    /// other chain refuses rather than deploy a court a stranger can vote in; there, the keys come
    /// from the secret store and the addresses are recorded in `AS_BUILT.md`.
    function _deployArena(address treasury) internal {
        require(
            block.chainid == 31337,
            "Demo seat keys derive from the public dev mnemonic; on any other chain load them from the secret store"
        );

        vm.startBroadcast(pkDeployer);
        court = new ArgusCourt();
        // Mode 0: the seed is `keccak256(prevrandao, block.number, id, round)`, which is not a
        // VRF. Mode 1 fails closed (`RandomnessNotConfigured`) until a consumer is wired, so a
        // demo that needs a panel can only run mode 0. Recorded as D-17, not left as script
        // behaviour.
        arena = new Arena(treasury, address(court), 0);
        court.setArena(address(arena));
        vm.stopBroadcast();

        uint256[6] memory keys = _seatKeys();
        address[6] memory seats;
        for (uint256 i; i < 6; ++i) {
            seats[i] = vm.addr(keys[i]);
        }

        // Seats four to six sit past anvil's ten funded genesis accounts. Fund them from the
        // deployer — a real transfer, because `vm.deal` is a cheatcode and does nothing against
        // an RPC.
        vm.startBroadcast(pkDeployer);
        for (uint256 i = 3; i < 6; ++i) {
            (bool ok,) = seats[i].call{value: SEAT_BOND * 2}("");
            require(ok, "could not fund a seat");
        }
        vm.stopBroadcast();

        for (uint256 i; i < 6; ++i) {
            vm.startBroadcast(keys[i]);
            court.bondSeat{value: SEAT_BOND}();
            vm.stopBroadcast();
        }

        require(court.poolLength() == 6, "seat pool is not six");
        for (uint256 i; i < 6; ++i) {
            (uint256 bond,,) = court.bondedOf(seats[i]);
            require(bond >= SEAT_BOND, "seat bond below the demo bond");
        }

        // One posted trial, so the per-trial floor is a measurement rather than a hypothesis.
        // The fee is read from `Params` rather than restated: a hardcoded 15% here would be a
        // second source of truth for a number the contract refuses a wrong payment against.
        uint256 fee = (ARENA_TRIAL_REWARD * Params.ARENA_FEE_BPS) / Params.BPS;
        vm.startBroadcast(pkSponsor);
        uint256 arenaTrial = arena.postTrial{value: ARENA_TRIAL_REWARD + fee}(
            ARENA_TRIAL_REWARD,
            SeedContent.SPEC_HASH,
            SeedContent.TESTS_HASH,
            keccak256("crucible-demo-holdout"),
            1 hours,
            1 days
        );
        vm.stopBroadcast();

        uint256 floor = arena.seatBondFloor(arenaTrial);
        require(floor > 0, "seat bond floor is zero, so the assert below would be vacuous");
        for (uint256 i; i < 6; ++i) {
            (uint256 bond,,) = court.bondedOf(seats[i]);
            require(bond >= floor, "seat bond below the posted trial's floor");
        }

        // The claim process. Claiming is what moves a posted trial out of `Open`, and it posts the
        // bond the Arena demands — `AGENT_BOND_MIN_BPS` of the reward, a different number from the
        // seat floor above. Naming the runner is the second half: `submitRun` refuses with
        // `NoRunner` until the agent has done it, so a trial that is claimed and runnerless is a
        // dead end rather than a claim waiting on work.
        uint256 agentBond = (ARENA_TRIAL_REWARD * Params.AGENT_BOND_MIN_BPS) / Params.BPS;
        vm.startBroadcast(pkOperatorA);
        arena.claimTrial{value: agentBond}(arenaTrial);
        arena.setRunner(arenaTrial, vm.addr(RUNNER_KEY));
        vm.stopBroadcast();

        // The run, signed the way the contract verifies it. `DOMAIN`, `RUN_TYPEHASH` and
        // `ATTEST_TYPEHASH` are all public, so this reproduces the digest instead of guessing at
        // it — the same two signatures `Arena.t.sol` builds, over the same fields.
        vm.startBroadcast(pkDeployer);
        arena.setAttestor(vm.addr(ATTESTOR_KEY), true);
        vm.stopBroadcast();

        bytes32 artifact = keccak256("crucible-demo-artifact");
        bytes32 verdictHash = keccak256("crucible-demo-verdict");
        bytes32 replayHash = keccak256("crucible-demo-replay");
        bytes32 harness = keccak256("crucible-demo-harness");
        uint64 sigDeadline = uint64(block.timestamp + 1 hours);
        uint64 nonce = 1;

        bytes32 runDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                arena.DOMAIN(),
                keccak256(
                    abi.encode(
                        arena.RUN_TYPEHASH(),
                        bytes32(arenaTrial),
                        vm.addr(pkOperatorA),
                        artifact,
                        verdictHash,
                        replayHash,
                        harness,
                        nonce,
                        sigDeadline
                    )
                )
            )
        );
        (uint8 rv, bytes32 rr, bytes32 rs) = vm.sign(RUNNER_KEY, runDigest);
        bytes memory runnerSig = abi.encodePacked(rr, rs, rv);

        bytes32 attestDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                arena.DOMAIN(),
                keccak256(
                    abi.encode(
                        arena.ATTEST_TYPEHASH(),
                        bytes32(arenaTrial),
                        artifact,
                        verdictHash,
                        replayHash,
                        true,
                        sigDeadline
                    )
                )
            )
        );
        (uint8 av, bytes32 ar, bytes32 asig) = vm.sign(ATTESTOR_KEY, attestDigest);
        bytes memory attestorSig = abi.encodePacked(ar, asig, av);

        vm.startBroadcast(pkOperatorA);
        arena.submitRun(
            arenaTrial, artifact, verdictHash, replayHash, harness, nonce, sigDeadline, runnerSig, attestorSig
        );
        vm.stopBroadcast();

        // The demo stops here, at `Submitted`, and that is a deliberate boundary rather than a
        // missing step. `freezeDocket` refuses until `windowEnd + BREAK_REVEAL_GRACE_SECONDS` has
        // passed — two hours on this parameter set — and a script cannot move that clock reliably:
        // `vm.rpc("evm_increaseTime")` moves the node while `vm.warp` moves only the simulated EVM
        // the preflight is checked against, and the two do not stay in step against a live chain.
        // `GoldenPath.s.sol` has the same shape and answers it the same way: the operator advances
        // the node between two script runs (`cast rpc anvil_setNextBlockTimestamp` + `anvil_mine`).
        // Measured on the demo chain, the trial sits `Submitted` with both signatures accepted,
        // which is the part that could not be tested without an attestor.
        //
        // Worth recording for whoever adds the freeze call: with zero revealed breaks,
        // `freezeDocket` does NOT open a panel. It settles the trial as O1 (`_settleNoBreak`) and
        // returns, so `drawPanel` reverts `BadState` — correctly, because an undefended trial has
        // no dispute to judge. A panel needs a revealed break first.

        // Both rounds must survive their real exclusion lists. `seatCount() >= 3` does not test
        // that: the pool is only large enough if three seats remain after round 2 excludes the
        // three trial parties AND all three round-1 seats.
        address[] memory round1 = new address[](3);
        round1[0] = vm.addr(pkSponsor);
        round1[1] = vm.addr(pkOperatorA);
        round1[2] = vm.addr(pkSkeptic);

        address[3] memory first = court.draw(1, round1, 0);

        address[] memory round2 = new address[](6);
        for (uint256 i; i < 3; ++i) {
            round2[i] = round1[i];
        }
        for (uint256 i; i < 3; ++i) {
            round2[3 + i] = first[i];
        }

        // Reverts `NotEnoughSeats` if a second panel cannot be filled.
        address[3] memory second = court.draw(2, round2, 0);
        require(
            second[0] != address(0) && second[1] != address(0) && second[2] != address(0), "round 2 drew an empty seat"
        );

        console.log("Arena", address(arena));
        console.log("ArgusCourt", address(court));
        console.log("seats bonded", uint256(6));
    }

    function _seatKeys() internal view returns (uint256[6] memory k) {
        k[0] = pkArgus1;
        k[1] = pkArgus2;
        k[2] = pkArgus3;
        k[3] = pkSeat4;
        k[4] = pkSeat5;
        k[5] = pkSeat6;
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
