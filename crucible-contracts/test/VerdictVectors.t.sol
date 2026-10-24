// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {VerdictVectors} from "./fixtures/VerdictVectors.sol";

/**
 * Gate 752, Solidity side — the third leg of the parity triangle.
 *
 * Contracts never canonicalize JSON: they verify pre-canonicalized bytes.
 * The canonical bytes and their expected digests live in a generated fixture
 * (test/fixtures/VerdictVectors.sol, written by scripts/vectors-generate.mjs
 * from the TypeScript reference alongside vectors/verdict/vectors.json), and
 * this test proves sha256 over those bytes equals the recorded digest — so a
 * verdict hash computed off-chain by TS or Rust is checkable on-chain with the
 * same thirty-two bytes.
 */
contract VerdictVectorsTest is Test {
    function test_Sha256OverCanonicalBytesMatchesEveryVector() public pure {
        string[] memory jcs = VerdictVectors.JCS();
        bytes32[] memory expected = VerdictVectors.EXPECTED();
        assertEq(jcs.length, expected.length, "fixture arrays must align");
        for (uint256 i = 0; i < jcs.length; i++) {
            bytes32 got = sha256(bytes(jcs[i]));
            assertEq(got, expected[i], VerdictVectors.NAMES()[i]);
        }
    }

    function test_FixtureCarriesAllSixVectors() public pure {
        assertGe(VerdictVectors.JCS().length, 6, "the six committed vectors must all be present");
    }
}
