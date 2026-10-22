// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// The pinned suite's subject: a counter that refuses to wrap.
contract Counter {
    uint256 public number;

    function setNumber(uint256 newNumber) external {
        number = newNumber;
    }

    function increment() external {
        require(number < type(uint256).max, "overflow");
        number++;
    }
}
