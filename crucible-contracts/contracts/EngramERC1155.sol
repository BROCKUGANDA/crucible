// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title EngramERC1155 — Crucible achievement collection (REW-002).
/// @notice Minimal ERC-1155 collection for Engrams without external deps.
///         Minting restricted to minter. Credential tokens (id < 2000) soulbound.
contract EngramERC1155 {
    address public immutable admin;
    address public minter;

    mapping(uint256 => mapping(address => uint256)) private _balances;
    mapping(uint256 => uint256) public cap;
    mapping(uint256 => uint256) public totalMinted;

    event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value);
    event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values);
    event EngramMinted(address indexed to, uint256 indexed tokenId, uint256 amount, bytes32 evidenceRef);
    event CapSet(uint256 indexed tokenId, uint256 newCap);
    event MinterSet(address indexed previousMinter, address indexed newMinter);

    error NotAdmin();
    error NotMinter();
    error AmountZero();
    error CapExceeded();
    error CapBelowMinted();
    error Soulbound();
    error LengthMismatch();
    error InsufficientBalance();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyMinter() {
        if (msg.sender != minter) revert NotMinter();
        _;
    }

    constructor() {
        admin = msg.sender;
        minter = msg.sender;
    }

    function setMinter(address newMinter) external onlyAdmin {
        address previousMinter = minter;
        minter = newMinter;
        emit MinterSet(previousMinter, newMinter);
    }

    function setCap(uint256 tokenId, uint256 newCap) external onlyAdmin {
        if (newCap != 0 && newCap < totalMinted[tokenId]) revert CapBelowMinted();
        cap[tokenId] = newCap;
        emit CapSet(tokenId, newCap);
    }

    function mint(address to, uint256 tokenId, uint256 amount, bytes32 evidenceRef) external onlyMinter {
        if (amount == 0) revert AmountZero();
        uint256 newTotal = totalMinted[tokenId] + amount;
        if (cap[tokenId] != 0 && newTotal > cap[tokenId]) revert CapExceeded();
        totalMinted[tokenId] = newTotal;
        _balances[tokenId][to] += amount;
        emit TransferSingle(msg.sender, address(0), to, tokenId, amount);
        emit EngramMinted(to, tokenId, amount, evidenceRef);
    }

    function mintBatch(address to, uint256[] calldata tokenIds, uint256[] calldata amounts, bytes32[] calldata evidenceRefs)
        external
        onlyMinter
    {
        if (tokenIds.length != amounts.length || tokenIds.length != evidenceRefs.length) revert LengthMismatch();
        for (uint256 i = 0; i < tokenIds.length; i++) {
            if (amounts[i] == 0) revert AmountZero();
            uint256 newTotal = totalMinted[tokenIds[i]] + amounts[i];
            if (cap[tokenIds[i]] != 0 && newTotal > cap[tokenIds[i]]) revert CapExceeded();
            totalMinted[tokenIds[i]] = newTotal;
            _balances[tokenIds[i]][to] += amounts[i];
            emit EngramMinted(to, tokenIds[i], amounts[i], evidenceRefs[i]);
        }
        emit TransferBatch(msg.sender, address(0), to, tokenIds, amounts);
    }

    function balanceOf(address account, uint256 id) external view returns (uint256) {
        return _balances[id][account];
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 amount) external {
        if (from != msg.sender) revert NotMinter();
        if (id < 2000) revert Soulbound();
        if (_balances[id][from] < amount) revert InsufficientBalance();
        _balances[id][from] -= amount;
        _balances[id][to] += amount;
        emit TransferSingle(msg.sender, from, to, id, amount);
    }

    function uri(uint256) external pure returns (string memory) {
        return "";
    }
}
