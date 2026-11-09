// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title EngramERC1155 — Crucible achievement collection (REW-002).
/// @notice Standards-compliant ERC-1155 with minter role, Safe admin, soulbound
/// credential ids (< 2000), governed metadata URI. Credential transfers revert;
/// collectible ids (>= 2000) are transferable by holders/operators.
/// @dev Base URI pattern: ipfs://<CID>/{id}.json with 64-hex lowercase ids
/// per EIP-1155 metadata JSON schema.
contract EngramERC1155 is ERC1155, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    mapping(uint256 => uint256) public cap;
    mapping(uint256 => uint256) public totalMinted;

    event EngramMinted(address indexed to, uint256 indexed tokenId, uint256 amount, bytes32 evidenceRef);
    event CapSet(uint256 indexed tokenId, uint256 newCap);

    error AmountZero();
    error CapExceeded();
    error CapBelowMinted();
    error Soulbound();
    error LengthMismatch();

    constructor(address admin, string memory baseUri) ERC1155(baseUri) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }

    function setMinter(address account, bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (enabled) _grantRole(MINTER_ROLE, account);
        else _revokeRole(MINTER_ROLE, account);
    }

    function setCap(uint256 tokenId, uint256 newCap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newCap != 0 && newCap < totalMinted[tokenId]) revert CapBelowMinted();
        cap[tokenId] = newCap;
        emit CapSet(tokenId, newCap);
    }

    function setURI(string memory newUri) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setURI(newUri);
    }

    function mint(address to, uint256 tokenId, uint256 amount, bytes32 evidenceRef) external onlyRole(MINTER_ROLE) {
        if (amount == 0) revert AmountZero();
        uint256 newTotal = totalMinted[tokenId] + amount;
        if (cap[tokenId] != 0 && newTotal > cap[tokenId]) revert CapExceeded();
        totalMinted[tokenId] = newTotal;
        _mint(to, tokenId, amount, "");
        emit EngramMinted(to, tokenId, amount, evidenceRef);
    }

    function mintBatch(
        address to,
        uint256[] calldata tokenIds,
        uint256[] calldata amounts,
        bytes32[] calldata evidenceRefs
    ) external onlyRole(MINTER_ROLE) {
        if (tokenIds.length != amounts.length || tokenIds.length != evidenceRefs.length) {
            revert LengthMismatch();
        }
        for (uint256 i = 0; i < tokenIds.length; i++) {
            if (amounts[i] == 0) revert AmountZero();
            uint256 newTotal = totalMinted[tokenIds[i]] + amounts[i];
            if (cap[tokenIds[i]] != 0 && newTotal > cap[tokenIds[i]]) revert CapExceeded();
            totalMinted[tokenIds[i]] = newTotal;
            emit EngramMinted(to, tokenIds[i], amounts[i], evidenceRefs[i]);
        }
        _mintBatch(to, tokenIds, amounts, "");
    }

    function _update(address from, address to, uint256[] memory ids, uint256[] memory values) internal override {
        for (uint256 i = 0; i < ids.length; i++) {
            if (ids[i] < 2000 && from != address(0)) revert Soulbound();
        }
        super._update(from, to, ids, values);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC1155, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
