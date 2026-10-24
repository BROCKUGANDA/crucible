// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title VerificationReceipt — soulbound proof that a Crucible trial settled.
///
/// One extra contract, zero money path: it mints, it holds no ETH and cannot receive it.
/// The minter is the `CrucibleTrials` contract that wired it (see `Deploy.s.sol`), so a
/// receipt can only be minted by the settlement path, never by a caller that merely
/// claims a trial passed.
///
/// Non-transferable by construction: there is no `transferFrom`, no `approve` and no
/// operator concept to revoke. This mirrors `AlloyRegistry` — see
/// `crucible-contracts/docs/contract-spec.md` §12, which tells integrators not to treat
/// a Crucible credential as a tradeable ERC-721. A reputation object that can be sold is
/// a reputation market, and that is a different product.
///
/// One receipt per trial, keyed by trial id: a retried settlement batch cannot mint a
/// second receipt for the same trial.
contract VerificationReceipt {
    // ───────────────────────── errors ─────────────────────────
    error NotMinter();
    error NotOwner();
    error ZeroAddress();
    error NotMinted();
    error AlreadyMinted(uint256 trialId);

    // ───────────────────────── events ─────────────────────────
    /// @notice ERC-721-shaped mint event. Only the `from == address(0)` leg is ever used,
    /// because a receipt never moves.
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event ReceiptMinted(uint256 indexed tokenId, uint256 indexed trialId, bytes32 verdictHash, uint256 graderVersion);
    event MinterSet(address indexed minter);

    // ───────────────────────── types ──────────────────────────
    struct ReceiptData {
        uint256 trialId;
        bytes32 verdictHash;
        bytes32 promptHash;
        uint256 graderVersion;
        uint64 mintedAt;
    }

    // ───────────────────────── storage ────────────────────────
    address public immutable owner;
    address public minter;

    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public balanceOf;
    mapping(uint256 => ReceiptData) public receipts;
    /// @notice trialId -> tokenId. Zero means that trial has no receipt.
    mapping(uint256 => uint256) public receiptIdOfTrial;

    uint256 public tokenCounter;

    // ───────────────────────── modifiers ──────────────────────
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyMinter() {
        if (msg.sender != minter) revert NotMinter();
        _;
    }

    constructor() {
        owner = msg.sender;
        minter = msg.sender;
    }

    /// @notice Owner sets the minter. CrucibleTrials is the minter in every wired deployment.
    function setMinter(address minter_) external onlyOwner {
        if (minter_ == address(0)) revert ZeroAddress();
        minter = minter_;
        emit MinterSet(minter_);
    }

    /// @notice True when `account` is the only address allowed to mint. Declared by
    /// `IVerificationReceipt`; implemented here so that interface is not a lie.
    function isMinter(address account) external view returns (bool) {
        return account == minter;
    }

    // ───────────────────────── minting ────────────────────────
    /// @notice Mint the one receipt for a settled trial. Minter-only, trial-idempotent.
    /// @param to the recipient — the settled agent's operator
    /// @param trialId the Crucible trial this receipt attests to
    /// @param verdictHash the settlement verdict commitment
    /// @param promptHash the trial's specCID (the pinned work)
    /// @param graderVersion the Warden version that produced the verdict
    /// @return tokenId the id of the minted receipt
    function mintReceipt(
        address to,
        uint256 trialId,
        bytes32 verdictHash,
        bytes32 promptHash,
        uint256 graderVersion
    ) external onlyMinter returns (uint256 tokenId) {
        if (to == address(0)) revert ZeroAddress();
        if (receiptIdOfTrial[trialId] != 0) revert AlreadyMinted(trialId);

        tokenId = ++tokenCounter;
        receiptIdOfTrial[trialId] = tokenId;
        ownerOf[tokenId] = to;
        balanceOf[to] += 1;
        receipts[tokenId] = ReceiptData({
            trialId: trialId,
            verdictHash: verdictHash,
            promptHash: promptHash,
            graderVersion: graderVersion,
            mintedAt: uint64(block.timestamp)
        });

        emit Transfer(address(0), to, tokenId);
        emit ReceiptMinted(tokenId, trialId, verdictHash, graderVersion);
    }

    // ───────────────────────── metadata ───────────────────────
    /// @notice On-chain JSON data URI. Carries the trial id this receipt attests to — the
    /// token id is a mint counter and is not the trial id.
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        ReceiptData storage r = receipts[tokenId];
        if (r.trialId == 0 && ownerOf[tokenId] == address(0)) revert NotMinted();
        return
            string.concat(
                'data:application/json,{"name":"Crucible Verification Receipt"',
                ',"description":"Non-transferable proof that trial ',
                uint256ToString(r.trialId),
                ' settled in Crucible Warden v',
                uint256ToString(r.graderVersion),
                '","attributes":[{"trait_type":"trialId","value":',
                uint256ToString(r.trialId),
                '},{"trait_type":"verdictHash","value":"',
                bytes32ToHex(r.verdictHash),
                '"},{"trait_type":"promptHash","value":"',
                bytes32ToHex(r.promptHash),
                '"},{"trait_type":"graderVersion","value":',
                uint256ToString(r.graderVersion),
                '},{"trait_type":"mintedAt","value":',
                uint256ToString(uint256(r.mintedAt)),
                '}]}'
            );
    }

    // ───────────────────────── encoding helpers ───────────────
    function bytes32ToHex(bytes32 b) internal pure returns (string memory) {
        bytes memory out = new bytes(66);
        out[0] = 0x30;
        out[1] = 0x78;
        for (uint256 i; i < 32; ++i) {
            bytes1 byte_ = bytes1(b >> (248 - i * 8));
            out[2 + i * 2] = nibbleToHex(byte_ >> 4);
            out[2 + i * 2 + 1] = nibbleToHex(byte_ & 0x0f);
        }
        return string(out);
    }

    function nibbleToHex(bytes1 n) internal pure returns (bytes1) {
        uint8 v = uint8(n);
        if (v < 10) return bytes1(48 + v);
        return bytes1(87 + v);
    }

    function uint256ToString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 tmp = v;
        uint256 digits = 0;
        while (tmp > 0) {
            tmp /= 10;
            digits += 1;
        }
        bytes memory s = new bytes(digits);
        while (v > 0) {
            digits -= 1;
            s[digits] = bytes1(48 + uint8(v % 10));
            v /= 10;
        }
        return string(s);
    }
}
