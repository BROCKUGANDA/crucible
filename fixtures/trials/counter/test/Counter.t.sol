// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Counter} from "../src/Counter.sol";

/// The suite a sponsor pins and a verifier re-runs.
///
/// Deliberately free of forge-std: a pinned suite is fetched by another process into a
/// directory that has none of this repository's libraries, so anything it imports has to
/// travel with it. Two named tests, so a claim that reports one and silently drops the
/// other is detectable rather than merely smaller.
contract CounterTest {
    function test_set_number() public {
        Counter counter = new Counter();
        counter.setNumber(7);
        require(counter.number() == 7, "setNumber did not store the value");
    }

    function test_increment_never_wraps() public {
        Counter counter = new Counter();
        counter.setNumber(type(uint256).max);
        try counter.increment() {
            require(false, "increment wrapped the maximum value");
        } catch {
            // The refusal is the pass.
        }
    }
}
