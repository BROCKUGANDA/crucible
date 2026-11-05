// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {CrucibleTrials} from "../contracts/CrucibleTrials.sol";
import {LocalTreasuryHolder} from "../contracts/mocks/LocalTreasuryHolder.sol";

/// The treasury money journey against a LIVE chain — the on-chain half of the
/// treasury workstream's T5. `GoldenPath.s.sol` proves the escrow's outcomes;
/// this proves where the money lands: the fee becomes a pull credit on the
/// configured treasury (a contract, never the deployer), `withdraw()` is the only
/// exit, and the credit ledger and the conservation identity stay exact.
///
///   Phase A (Begin):  sponsor funds a trial; an agent registers, claims and submits
///                     a runner-signed run.
///   (between:         the operator warps the node past the skeptic window —
///                     `cast rpc anvil_setNextBlockTimestamp` + `anvil_mine`)
///   Phase B (Finish): a relayer finalizes (silence is acceptance); the treasury
///                     contract pulls its fee; the agent pulls the payout.
///
///   TRIALS=0x… forge script script/TreasuryPipelineDemo.s.sol:Begin --rpc-url <anvil> --broadcast
///   cast rpc anvil_setNextBlockTimestamp <runAt + breakWindow + 1> --rpc-url <anvil>
///   cast rpc anvil_mine 1 --rpc-url <anvil>
///   TRIALS=0x… forge script script/TreasuryPipelineDemo.s.sol:Finish --rpc-url <anvil> --broadcast
///
/// Every actor is an Anvil genesis account from the published dev mnemonic, same
/// rule as GoldenPath.s.sol: the money must move in real signed transactions a
/// ledger reader can quote, not in simulated pranks.
contract TreasuryPipelineDemo is Script {
    string constant DEV_MNEMONIC = "test test test test test test test test test test test junk";
    uint256 constant RUNNER_KEY = 0xA11CE;
    uint256 constant REWARD = 1 ether; // bond 0.2 ETH, fee 0.05 ETH on a win

    CrucibleTrials internal trials;
    uint256 internal pkSponsor;
    uint256 internal pkOperator;
    uint256 internal pkRelayer;

    function _wire() internal {
        trials = CrucibleTrials(vm.envAddress("TRIALS"));
        pkSponsor = vm.deriveKey(DEV_MNEMONIC, 4);
        pkOperator = vm.deriveKey(DEV_MNEMONIC, 5);
        pkRelayer = vm.deriveKey(DEV_MNEMONIC, 8);
    }

    function run() external {
        _wire();
        // The chain must already be deployed (script/Deploy.s.sol). The treasury is
        // read back from the contract, not from an argument — the demo proves the
        // deployed value, so trusting an env var would prove nothing.
        address treasury = trials.treasury();
        require(treasury.code.length > 0, "demo: the treasury must be a contract (Deploy.s.sol enforces this)");
        console.log("treasury (read from the deployed contract)", treasury);
    }

    /// Phase A: sponsor funds, agent claims, run submitted with the runner's signature.
    function Begin() external {
        _wire();
        vm.broadcast(pkSponsor);
        uint256 id = trials.createTrial{value: REWARD}(
            REWARD,
            keccak256("treasury-pipeline-spec"),
            keccak256("treasury-pipeline-tests"),
            uint64(block.timestamp + 2 days),
            12 hours
        );
        console.log("trial", id);

        vm.broadcast(pkOperator);
        uint256 agentId = trials.registerAgent{value: 1 ether}("ipfs://treasury-pipeline", vm.addr(RUNNER_KEY));
        console.log("agent", agentId);

        vm.broadcast(pkOperator);
        trials.claimTrial(id);

        uint64 sigDeadline = uint64(block.timestamp + 10 minutes);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                trials.DOMAIN(),
                keccak256(
                    abi.encode(trials.RUN_TYPEHASH(), id, agentId, keccak256("treasury-pipeline-run"), sigDeadline)
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RUNNER_KEY, digest);
        vm.broadcast(pkRelayer);
        trials.submitRun(id, keccak256("treasury-pipeline-run"), abi.encodePacked(r, s, v), sigDeadline);

        console.log("windowEnd", uint256(trials.runAtOf(id)) + uint256(trials.breakWindowOf(id)));
        console.log("BEGIN complete: trial", id, "is Judging; warp past windowEnd, then run :Finish");
    }

    /// Phase B: finalize, then both pulls — the treasury contract's fee and the agent's payout.
    function Finish() external {
        _wire();
        uint256 id = _lastJudgingTrial();
        CrucibleTrials.Trial memory t = trials.getTrial(id);
        require(t.status == CrucibleTrials.Status.Judging, "demo: the last trial is not Judging");

        uint256 fee = (uint256(t.reward) * trials.FEE_BPS()) / trials.BPS();
        uint256 agentId = t.agentId;

        // Silence is acceptance; any relayer may trigger it.
        vm.broadcast(pkRelayer);
        trials.finalize(id);

        (address agentOperator,,,,) = trials.agents(agentId);
        uint256 agentCredit = trials.credit(agentOperator);
        uint256 treasuryCredit = trials.credit(trials.treasury());
        require(agentCredit == uint256(t.reward) - fee, "demo: agent credit is not reward minus fee");
        require(treasuryCredit == fee, "demo: treasury credit is not exactly the fee");
        console.log("SETTLED: fee", fee);
        console.log("treasuryCredit", treasuryCredit);
        console.log("agentCredit", agentCredit);

        // The treasury is a contract: it must call withdraw() itself. This is the
        // boundary the Safe obeys on production — no push, no relay, no exception.
        // The pull is a REAL broadcast transaction (a raw .call here would only
        // simulate — measured: the ledger replayed one withdrawal short), sent by
        // the relayer because holder.pull is permissionless: the escrow pays the
        // caller's own credit, and the caller is the holder contract.
        address treasury = trials.treasury();
        vm.broadcast(pkRelayer);
        LocalTreasuryHolder(payable(treasury)).pull(address(trials));
        require(trials.credit(treasury) == 0, "demo: treasury credit was not zeroed by the pull");
        console.log("treasuryWithdrawn", fee);

        // The agent pulls their payout from the same ledger.
        (address operator,,,,) = trials.agents(agentId);
        vm.broadcast(pkOperator);
        trials.withdraw();
        require(trials.credit(operator) == 0, "demo: agent credit was not zeroed by the pull");
        console.log("FINISH complete: the fee reached the treasury contract and the payout the agent");
    }

    /// The highest trial still in Judging — the one this demo's Phase A created.
    function _lastJudgingTrial() internal view returns (uint256) {
        for (uint256 id = trials.trialCount(); id >= 1; --id) {
            if (trials.getTrial(id).status == CrucibleTrials.Status.Judging) return id;
        }
        revert("demo: no trial in Judging");
    }
}
