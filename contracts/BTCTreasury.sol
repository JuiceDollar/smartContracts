// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IJuiceDollar} from "./interface/IJuiceDollar.sol";
import {IReserve} from "./interface/IReserve.sol";
import {IWrappedNative} from "./interface/IWrappedNative.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title BTCTreasury
 * @notice Protocol-owned BTC treasury that gives JUICE holders leveraged BTC exposure.
 *
 * Inspired by Strategy's (formerly MicroStrategy) STRC/MSTR model:
 *
 * 1. The PROTOCOL owns cBTC — not individual users (like Strategy owns BTC, not STRC holders)
 * 2. JUSD is minted against the cBTC (like Strategy issues STRC to fund BTC purchases)
 * 3. JUICE holders have leveraged BTC exposure (like MSTR shareholders)
 * 4. No liquidation — if BTC drops, the protocol holds; no margin call
 *
 * Key mechanism: `rebalance()` captures BTC upside into equity. When BTC rises,
 * governance mints additional JUSD to the equity pool as profit, increasing JUICE price.
 * This is how the BTC leverage flows to JUICE holders.
 *
 * Users interact via `investBTC()` (cBTC → JUICE) and standard equity redemption (JUICE → JUSD).
 * There are no per-user positions, no abandoned accounts, no reserve contamination.
 */
contract BTCTreasury {
    using SafeERC20 for IERC20;

    uint256 private constant ONE_DEC18 = 10 ** 18;

    /**
     * @notice Emergency quorum in basis points. 1000 = 10%.
     */
    uint32 private constant EMERGENCY_QUORUM = 1000;

    /**
     * @notice Timelock for mint ceiling changes.
     */
    uint40 private constant CEILING_CHANGE_DELAY = 7 days;

    IJuiceDollar public immutable JUSD;
    IERC20 public immutable cBTC;
    address public immutable WCBTC;

    /**
     * @notice Reserve contribution in PPM for initial minting via investBTC.
     */
    uint24 public immutable reservePPM;

    /**
     * @notice Maximum JUSD mintable per 1e18 cBTC.
     * Functions like a conservative "price" set by governance instead of an oracle.
     * Example: 35000e18 means max 35,000 JUSD per cBTC (~50% LTV at $70k BTC).
     */
    uint256 public mintCeiling;

    /**
     * @notice Pending mint ceiling change.
     */
    uint256 public nextMintCeiling;
    uint40 public ceilingChangeTime;

    /**
     * @notice Whether this module has been permanently stopped via emergency stop.
     */
    bool public stopped;

    /**
     * @notice Total JUSD minted by this treasury (protocol-level debt).
     */
    uint256 public totalMintedJUSD;

    /**
     * @notice Portion of totalMintedJUSD that was minted via mintWithReserve (investBTC).
     * The remainder (totalMintedJUSD - reservedMintedJUSD) was minted via mint() (rebalance profits)
     * and has no reserve tracking in the JUSD token.
     */
    uint256 public reservedMintedJUSD;

    event BTCInvested(address indexed investor, uint256 cbtcAmount, uint256 jusdMinted, uint256 juiceReceived);
    event Rebalanced(uint256 jusdProfit);
    event BTCSold(address indexed buyer, uint256 cbtcAmount, uint256 jusdReceived);
    event BTCReceived(address indexed sender, uint256 cbtcAmount);
    event CeilingProposed(address indexed proposer, uint256 newCeiling, uint40 effectiveTime);
    event CeilingChanged(uint256 newCeiling);
    event EmergencyStopped(address indexed caller, string message);

    error Stopped();
    error AlreadyStopped();
    error NotQualified();
    error NoGovernance();
    error ExceedsCeiling(uint256 requested, uint256 available);
    error NoPendingChange();
    error ChangeNotReady();
    error NativeNotSupported();
    error NothingToRebalance();
    error NativeTransferFailed();
    error ZeroAmount();

    modifier notStopped() {
        if (stopped) revert Stopped();
        _;
    }

    constructor(
        address _jusd,
        address _cbtc,
        address _wcbtc,
        uint24 _reservePPM,
        uint256 _initialMintCeiling
    ) {
        JUSD = IJuiceDollar(_jusd);
        cBTC = IERC20(_cbtc);
        WCBTC = _wcbtc;
        reservePPM = _reservePPM;
        mintCeiling = _initialMintCeiling;
    }

    // ========== USER FUNCTIONS ==========

    /**
     * @notice Buy JUICE with cBTC in one atomic transaction.
     *
     * Flow:
     * 1. User sends cBTC → protocol owns it
     * 2. Treasury mints JUSD against cBTC (at governance ceiling, with reserve contribution)
     * 3. Usable JUSD is invested into equity → JUICE shares minted
     * 4. JUICE shares go to the user
     *
     * The cBTC stays in the treasury permanently. When BTC rises, `rebalance()` captures
     * the upside as equity profit, increasing JUICE price for all holders.
     *
     * @param cbtcAmount Amount of cBTC to invest (0 if using msg.value for native).
     * @param minShares Minimum JUICE shares expected (front-running protection).
     * @return shares The number of JUICE shares received.
     */
    function investBTC(uint256 cbtcAmount, uint256 minShares) external payable notStopped returns (uint256 shares) {
        cbtcAmount = _receiveBTC(cbtcAmount);

        // Mint JUSD against cBTC at ceiling price
        uint256 jusdToMint = (cbtcAmount * mintCeiling) / ONE_DEC18;
        if (jusdToMint == 0) revert ZeroAmount();
        _checkCeiling(jusdToMint);

        // Effects: update state before external calls (CEI)
        totalMintedJUSD += jusdToMint;
        reservedMintedJUSD += jusdToMint;

        // Interactions: mint with reserve, invest into equity, transfer JUICE
        uint256 usableJUSD = (jusdToMint * (1_000_000 - reservePPM)) / 1_000_000;
        JUSD.mintWithReserve(address(this), jusdToMint, reservePPM);

        IReserve equity = JUSD.reserve();
        shares = equity.invest(usableJUSD, minShares);
        IERC20(address(equity)).safeTransfer(msg.sender, shares);

        emit BTCInvested(msg.sender, cbtcAmount, jusdToMint, shares);
    }

    /**
     * @notice Donate cBTC to the treasury without receiving JUICE.
     * Increases BTC backing for all JUICE holders.
     * @param cbtcAmount Amount to donate (0 if using msg.value for native).
     */
    function donateBTC(uint256 cbtcAmount) external payable {
        cbtcAmount = _receiveBTC(cbtcAmount);
        emit BTCReceived(msg.sender, cbtcAmount);
    }

    // ========== GOVERNANCE: REBALANCING ==========

    /**
     * @notice Capture BTC upside for JUICE holders.
     *
     * When BTC rises, the treasury's cBTC can support more JUSD at the current ceiling.
     * This function mints the excess JUSD directly to the equity pool as profit,
     * increasing equity and thus JUICE price.
     *
     * Example: Treasury holds 100 cBTC, ceiling was 35k, totalMinted = 3.5M JUSD.
     * BTC rises 50%, governance raises ceiling to 52.5k. Now max mintable = 5.25M.
     * Rebalance mints 1.75M JUSD → equity → JUICE price increases ~50% (leveraged).
     *
     * @param helpers Addresses that delegated their votes to the caller.
     */
    function rebalance(address[] calldata helpers) external {
        _checkGovernance(helpers);

        uint256 cbtcBalance = cBTC.balanceOf(address(this));
        uint256 maxMintable = (cbtcBalance * mintCeiling) / ONE_DEC18;

        if (maxMintable <= totalMintedJUSD) revert NothingToRebalance();

        uint256 profit = maxMintable - totalMintedJUSD;

        // Mint JUSD directly to equity pool as profit (no reserve tracking for pure profit)
        JUSD.mint(address(JUSD.reserve()), profit);
        totalMintedJUSD += profit;

        emit Rebalanced(profit);
    }

    /**
     * @notice Sell cBTC from the treasury in exchange for JUSD to deleverage.
     *
     * Used when governance wants to reduce BTC exposure or needs to cover losses.
     * The buyer pays JUSD which gets burned, reducing the protocol's JUSD debt.
     *
     * @param buyer Address that pays JUSD and receives cBTC.
     * @param cbtcAmount Amount of cBTC to sell.
     * @param jusdPayment Amount of JUSD the buyer pays.
     * @param helpers Governance helpers.
     */
    function sellBTC(
        address buyer,
        uint256 cbtcAmount,
        uint256 jusdPayment,
        address[] calldata helpers
    ) external {
        _checkGovernance(helpers);
        if (cbtcAmount == 0 || jusdPayment == 0) revert ZeroAmount();

        // Take JUSD from buyer
        IERC20(address(JUSD)).safeTransferFrom(buyer, address(this), jusdPayment);

        // Burn JUSD to reduce protocol debt, distinguishing reserved vs unreserved portions.
        // Reserved JUSD (from investBTC) is burned via burnWithoutReserve to properly unwind minterReserveE6.
        // Unreserved JUSD (from rebalance profits) is burned via plain burn() with no reserve interaction.
        uint256 burnAmount = jusdPayment > totalMintedJUSD ? totalMintedJUSD : jusdPayment;

        // Effects: update state before external burn calls (CEI)
        totalMintedJUSD -= burnAmount;

        if (burnAmount > 0) {
            uint256 reservedBurn = burnAmount > reservedMintedJUSD ? reservedMintedJUSD : burnAmount;
            uint256 unreservedBurn = burnAmount - reservedBurn;

            reservedMintedJUSD -= reservedBurn;

            // Interactions: burn reserved portion (with reserve unwinding)
            if (reservedBurn > 0) {
                JUSD.burnWithoutReserve(reservedBurn, reservePPM);
            }
            // Burn unreserved portion (plain burn, no reserve interaction)
            if (unreservedBurn > 0) {
                JUSD.burn(unreservedBurn);
            }
        }

        // Send excess JUSD (if jusdPayment > totalMintedJUSD) to equity pool as profit
        uint256 excess = jusdPayment - burnAmount;
        if (excess > 0) {
            IERC20(address(JUSD)).safeTransfer(address(JUSD.reserve()), excess);
        }

        // Send cBTC to buyer
        cBTC.safeTransfer(buyer, cbtcAmount);

        emit BTCSold(buyer, cbtcAmount, jusdPayment);
    }

    // ========== GOVERNANCE: CONFIGURATION ==========

    /**
     * @notice Propose a new mint ceiling. Requires 2% governance quorum.
     *         Takes effect after CEILING_CHANGE_DELAY.
     * @param newCeiling New max JUSD per 1e18 cBTC.
     * @param helpers Addresses that delegated their votes to the caller.
     */
    function proposeMintCeiling(uint256 newCeiling, address[] calldata helpers) external {
        _checkGovernance(helpers);

        nextMintCeiling = newCeiling;
        ceilingChangeTime = uint40(block.timestamp) + CEILING_CHANGE_DELAY;
        emit CeilingProposed(msg.sender, newCeiling, ceilingChangeTime);
    }

    /**
     * @notice Apply a previously proposed mint ceiling change after the timelock.
     */
    function applyCeilingChange() external {
        if (nextMintCeiling == mintCeiling) revert NoPendingChange();
        if (block.timestamp < ceilingChangeTime) revert ChangeNotReady();

        mintCeiling = nextMintCeiling;
        emit CeilingChanged(mintCeiling);
    }

    /**
     * @notice Permanently stop this module in case of emergency.
     * @dev Requires 10% governance power. Once stopped, no new investments.
     *      Governance can still sell BTC and rebalance.
     * @param helpers Addresses that delegated their votes to the caller.
     * @param message Reason for the emergency stop.
     */
    function emergencyStop(address[] calldata helpers, string calldata message) external {
        if (stopped) revert AlreadyStopped();

        IReserve reserve = JUSD.reserve();
        uint256 _totalVotes = reserve.totalVotes();
        if (_totalVotes == 0) revert NoGovernance();

        uint256 _votes = reserve.votesDelegated(msg.sender, helpers);
        if (_votes * 10_000 < EMERGENCY_QUORUM * _totalVotes) revert NotQualified();

        stopped = true;
        emit EmergencyStopped(msg.sender, message);
    }

    // ========== VIEW FUNCTIONS ==========

    /**
     * @notice Returns the treasury's cBTC balance.
     */
    function btcBalance() external view returns (uint256) {
        return cBTC.balanceOf(address(this));
    }

    /**
     * @notice Returns how much additional JUSD can be minted via rebalance or investBTC.
     */
    function availableToMint() external view returns (uint256) {
        uint256 maxMintable = (cBTC.balanceOf(address(this)) * mintCeiling) / ONE_DEC18;
        return maxMintable > totalMintedJUSD ? maxMintable - totalMintedJUSD : 0;
    }

    /**
     * @notice Returns the "health ratio" of the treasury: cBTC value at ceiling / total JUSD debt.
     *         100% = fully backed, >100% = excess collateral, <100% = underwater.
     * @return ratio in basis points (10000 = 100%)
     */
    function healthRatio() external view returns (uint256) {
        if (totalMintedJUSD == 0) return type(uint256).max;
        uint256 maxMintable = (cBTC.balanceOf(address(this)) * mintCeiling) / ONE_DEC18;
        return (maxMintable * 10_000) / totalMintedJUSD;
    }

    // ========== INTERNAL ==========

    /**
     * @notice Handle cBTC receipt — either native (msg.value) or ERC20 transfer.
     * @return amount The actual amount received.
     */
    function _receiveBTC(uint256 amount) internal returns (uint256) {
        if (msg.value > 0) {
            if (address(cBTC) != WCBTC) revert NativeNotSupported();
            amount = msg.value;
            IWrappedNative(WCBTC).deposit{value: msg.value}();
        } else {
            if (amount == 0) revert ZeroAmount();
            cBTC.safeTransferFrom(msg.sender, address(this), amount);
        }
        return amount;
    }

    /**
     * @notice Check that minting `amount` does not exceed the ceiling.
     */
    function _checkCeiling(uint256 amount) internal view {
        uint256 cbtcBalance = cBTC.balanceOf(address(this));
        uint256 maxMintable = (cbtcBalance * mintCeiling) / ONE_DEC18;
        if (totalMintedJUSD + amount > maxMintable) {
            uint256 available = maxMintable > totalMintedJUSD ? maxMintable - totalMintedJUSD : 0;
            revert ExceedsCeiling(amount, available);
        }
    }

    /**
     * @notice Check that caller has 2% governance quorum.
     */
    function _checkGovernance(address[] calldata helpers) internal view {
        JUSD.reserve().checkQualified(msg.sender, helpers);
    }

    /**
     * @notice Required to receive native coin when unwrapping WcBTC.
     */
    receive() external payable {}
}
