// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {TeamLedger} from "../contracts/TeamLedger.sol";
import {CrucibleTrials} from "../contracts/CrucibleTrials.sol";

/**
 * Deploys the TeamLedger and runs one team through every state it has, on the demo chain.
 *
 * Why this exists: `GET /teams`, its indexer projection and the page beneath them were all wired to
 * a contract nothing ever deployed, so the honest answer was always `projected: false`. Deploying it
 * and driving one real team is what makes that path measurable instead of theoretical.
 *
 * Nothing here is invented for the demo. Each member's share is agreed by that member's own
 * signature, each stage attestation is signed by the member who did the work (the contract takes
 * `msg.sender` as the member, so a lead submitting it reverts `BadSignature`), and the two stage
 * hashes are the suite and spec commitments trial 1 already carries on this chain — a reader can
 * fetch the trial, re-derive both digests and check them against the ledger's own log.
 *
 * What is demo is the cast and the money: the parties are Anvil's published test accounts and the
 * ETH split at the end is worthless. `TeamLedger` sits beside the escrow and cannot reach into it —
 * one trial still has one claimant, one bond and one 5% fee (`FEE_BPS = 500`).
 */
contract Teams is Script {
    /// Anvil's published development mnemonic. Not a secret: every account it derives is public,
    /// which is exactly why the funds in them are worthless.
    string constant DEV_MNEMONIC = "test test test test test test test test test test test junk";

    uint256 internal pkDeployer;
    uint256 internal pkLead;
    uint256 internal pkWorker;
    uint256 internal pkCritic;
    uint256 internal pkSponsor;

    /// What the sponsor puts aside for the team's split. Under these shares any whole-ether amount
    /// divides exactly, so this run exercises the even path and measures it (`remainderToLead` is
    /// asserted in `test/TeamLedger.t.sol`, where an awkward amount is used deliberately).
    uint256 constant TEAM_FUND = 0.6 ether;

    TeamLedger internal ledger;

    function run() external {
        _keys();

        // The trial whose commitments become the stage hashes. Read from the chain the seed just
        // wrote, not from a file this script would have to guess the path of.
        CrucibleTrials trials = CrucibleTrials(vm.envAddress("TRIALS_ADDRESS"));
        CrucibleTrials.Trial memory t = trials.getTrial(1);
        require(t.sponsor != address(0), "Teams.s.sol: trial 1 does not exist on this chain");
        require(t.testsCID != bytes32(0) && t.specCID != bytes32(0), "Teams.s.sol: trial 1 carries no commitments");

        vm.startBroadcast(pkDeployer);
        ledger = new TeamLedger();
        vm.stopBroadcast();

        bytes32 teamKey = keccak256("team:counter-suite");
        uint256 deadline = type(uint256).max;

        address[] memory members = new address[](3);
        members[0] = vm.addr(pkLead);
        members[1] = vm.addr(pkWorker);
        members[2] = vm.addr(pkCritic);

        uint256[] memory shares = new uint256[](3);
        shares[0] = 5000;
        shares[1] = 3000;
        shares[2] = 2000;

        bytes[] memory sigs = new bytes[](3);
        for (uint256 i; i < members.length; ++i) {
            sigs[i] = _teamSig(teamKey, members[i], shares[i], deadline);
        }

        vm.startBroadcast(pkDeployer);
        ledger.createTeam(teamKey, members, shares, deadline, sigs);
        vm.stopBroadcast();

        // Stage one is the suite the worker ran; stage two the spec the critic graded against. Each
        // attestation is broadcast by its own member, because attribution a lead could add after the
        // fact would not be attribution.
        _attest(teamKey, t.testsCID, deadline, pkWorker);
        _attest(teamKey, t.specCID, deadline, pkCritic);

        vm.broadcast(pkSponsor);
        ledger.fund{value: TEAM_FUND}(teamKey);

        _requireConservation("after funding");
        require(ledger.held(teamKey) == TEAM_FUND, "funding did not land on the team's hold");

        vm.startBroadcast(pkDeployer);
        ledger.distribute(teamKey);
        vm.stopBroadcast();

        _requireConservation("after distribution");
        require(ledger.heldTotal() == 0, "distribution left a hold behind");
        require(ledger.team(teamKey).stageCount == 2, "the two stages did not land");
        require(ledger.credit(members[1]) == (TEAM_FUND * 3000) / 10_000, "worker share is not what it signed");

        console.log("TeamLedger", address(ledger));
        console.log(
            "  team 1: 3 members, 2 stages attested against trial 1's commitments, split",
            vm.toString(ledger.totalCredit())
        );
    }

    function _requireConservation(string memory where) internal view {
        (uint256 balance, uint256 held, uint256 credits) = ledger.conservationDetail();
        require(balance == held + credits, "team ledger conservation broken");
        where;
    }

    function _attest(bytes32 teamKey, bytes32 stageHash, uint256 deadline, uint256 signerKey) internal {
        address signer = vm.addr(signerKey);
        uint256 seq = ledger.team(teamKey).stageCount;
        bytes32 structHash = keccak256(abi.encode(ledger.STAGE_TYPEHASH(), teamKey, stageHash, seq, signer, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", ledger.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);

        vm.broadcast(signerKey);
        ledger.attestStage(teamKey, stageHash, deadline, abi.encodePacked(r, s, v));
    }

    function _teamSig(bytes32 teamKey, address member, uint256 shareBps, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(ledger.TEAM_TYPEHASH(), teamKey, member, shareBps, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", ledger.DOMAIN_SEPARATOR(), structHash));
        uint256 key = member == vm.addr(pkWorker) ? pkWorker : (member == vm.addr(pkCritic) ? pkCritic : pkLead);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _keys() internal {
        pkDeployer = vm.deriveKey(DEV_MNEMONIC, 0);
        pkLead = vm.deriveKey(DEV_MNEMONIC, 0);
        pkWorker = vm.deriveKey(DEV_MNEMONIC, 4);
        pkCritic = vm.deriveKey(DEV_MNEMONIC, 5);
        pkSponsor = vm.deriveKey(DEV_MNEMONIC, 6);
    }
}
