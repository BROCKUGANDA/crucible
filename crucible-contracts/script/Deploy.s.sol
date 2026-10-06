// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {CrucibleTrials} from "../contracts/CrucibleTrials.sol";
import {AlloyRegistry} from "../contracts/AlloyRegistry.sol";

contract Deploy is Script {
    uint256 internal constant DEFAULT_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function run() external returns (CrucibleTrials trials, AlloyRegistry alloy) {
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(DEFAULT_PK));
        vm.startBroadcast(pk);
        alloy = new AlloyRegistry();
        trials = new CrucibleTrials(vm.addr(pk), address(alloy), _seats());
        alloy.setForge(address(trials));
        vm.stopBroadcast();
        _report(address(alloy), address(trials));
    }

    function _seats() internal returns (address[] memory seats) {
        seats = new address[](3);
        seats[0] = vm.addr(0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d);
        seats[1] = vm.addr(0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a);
        seats[2] = vm.addr(0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6);
    }

    function _report(address alloyAddr, address trialsAddr) internal pure {
        console.log("AlloyRegistry", alloyAddr);
        console.log("CrucibleTrials", trialsAddr);
    }
}
