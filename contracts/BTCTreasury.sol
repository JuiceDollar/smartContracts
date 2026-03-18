// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IJuiceDollar} from "./interface/IJuiceDollar.sol";
import {IReserve} from "./interface/IReserve.sol";
import {ILeadrate} from "./interface/ILeadrate.sol";
import {IWrappedNative} from "./interface/IWrappedNative.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title BTCTreasury
 * @notice A minter module that allows users to deposit cBTC and mint JUSD without liquidation risk.
 *
 * Inspired by Strategy's (formerly MicroStrategy) STRC/MSTR model:
 * - Users deposit cBTC collateral and mint JUSD at a governance-set ceiling price
 * - Interest accrues continuously (leadrate + risk premium), collected as protocol profit
 * - Positions are NEVER liquidated — if BTC drops, JUICE holders absorb the equity reduction
 * - Users must repay JUSD + interest to reclaim their cBTC
 *
 * This gives JUICE holders leveraged BTC exposure without margin-call risk, analogous to how
 * MSTR shareholders benefit from BTC upside funded by STRC preferred stock issuance.
 *
 * The mint ceiling replaces oracles: governance decides the maximum JUSD mintable per cBTC,
 * similar to how Strategy's board decides STRC issuance volume.
 */
contract BTCTreasury {
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
    ILeadrate public immutable RATE;
    address public immutable WCBTC;

    /**
     * @notice Risk premium on top of the leadrate, in PPM.
     * Higher than normal positions to compensate for the lack of liquidation.
     */
    uint24 public immutable riskPremiumPPM;

    /**
     * @notice Reserve contribution in PPM. Portion of minted amount sent to equity pool.
     */
    uint24 public immutable reservePPM;

    /**
     * @notice Maximum JUSD mintable per 1e18 cBTC (18 decimals for 18-decimal collateral).
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
     * @notice Total JUSD principal minted across all accounts.
     */
    uint256 public totalMinted;

    struct Account {
        uint256 collateral; // cBTC deposited
        uint256 principal; // JUSD minted (gross, before reserve split)
        uint256 interest; // accrued interest owed
        uint24 fixedAnnualRatePPM; // locked-in annual rate at time of last mint
        uint40 lastAccrual; // timestamp of last interest accrual
    }

    mapping(address => Account) public accounts;

    event Deposited(address indexed account, uint256 cbtcAmount);
    event Minted(address indexed account, uint256 jusdAmount);
    event Repaid(address indexed account, uint256 jusdAmount);
    event Withdrawn(address indexed account, uint256 cbtcAmount);
    event CeilingProposed(address indexed proposer, uint256 newCeiling, uint40 effectiveTime);
    event CeilingChanged(uint256 newCeiling);
    event EmergencyStopped(address indexed caller, string message);

    error Stopped();
    error AlreadyStopped();
    error NotQualified();
    error NoGovernance();
    error ExceedsCeiling(uint256 requested, uint256 available);
    error InsufficientCollateral(uint256 requested, uint256 available);
    error InsufficientRepayment(uint256 requested, uint256 owed);
    error NoPendingChange();
    error ChangeNotReady();
    error NativeTransferFailed();
    error ZeroAmount();

    modifier notStopped() {
        if (stopped) revert Stopped();
        _;
    }

    constructor(
        address _jusd,
        address _cbtc,
        address _rate,
        address _wcbtc,
        uint24 _riskPremiumPPM,
        uint24 _reservePPM,
        uint256 _initialMintCeiling
    ) {
        JUSD = IJuiceDollar(_jusd);
        cBTC = IERC20(_cbtc);
        RATE = ILeadrate(_rate);
        WCBTC = _wcbtc;
        riskPremiumPPM = _riskPremiumPPM;
        reservePPM = _reservePPM;
        mintCeiling = _initialMintCeiling;
    }

    // ========== USER FUNCTIONS ==========

    /**
     * @notice Deposit cBTC collateral into your account.
     * @param amount Amount of cBTC to deposit. For native cBTC, send msg.value instead.
     */
    function deposit(uint256 amount) external payable notStopped {
        if (msg.value > 0) {
            amount = msg.value;
            IWrappedNative(WCBTC).deposit{value: msg.value}();
        } else {
            if (amount == 0) revert ZeroAmount();
            cBTC.transferFrom(msg.sender, address(this), amount);
        }

        _accrueInterest(msg.sender);
        accounts[msg.sender].collateral += amount;
        emit Deposited(msg.sender, amount);
    }

    /**
     * @notice Mint JUSD against your deposited cBTC collateral.
     * @dev The effective amount received is `amount * (1 - reservePPM/1e6)`.
     *      The rest goes to the equity pool as reserve.
     * @param amount Gross JUSD to mint (including reserve portion).
     */
    function mint(uint256 amount) external notStopped {
        if (amount == 0) revert ZeroAmount();

        Account storage account = accounts[msg.sender];
        _accrueInterest(msg.sender);

        // Lock in the current rate on each mint
        account.fixedAnnualRatePPM = RATE.currentRatePPM() + riskPremiumPPM;

        // Check mint ceiling: total principal must not exceed collateral * ceiling / 1e18
        uint256 maxMintable = (account.collateral * mintCeiling) / ONE_DEC18;
        if (account.principal + amount > maxMintable) {
            revert ExceedsCeiling(amount, maxMintable - account.principal);
        }

        account.principal += amount;
        totalMinted += amount;

        JUSD.mintWithReserve(msg.sender, amount, reservePPM);
        emit Minted(msg.sender, amount);
    }

    /**
     * @notice Deposit cBTC and mint JUSD in one transaction.
     * @param cbtcAmount Amount of cBTC to deposit (0 if using msg.value for native).
     * @param jusdAmount Gross JUSD to mint.
     */
    function depositAndMint(uint256 cbtcAmount, uint256 jusdAmount) external payable notStopped {
        // Deposit
        if (msg.value > 0) {
            cbtcAmount = msg.value;
            IWrappedNative(WCBTC).deposit{value: msg.value}();
        } else {
            if (cbtcAmount == 0) revert ZeroAmount();
            cBTC.transferFrom(msg.sender, address(this), cbtcAmount);
        }

        Account storage account = accounts[msg.sender];
        _accrueInterest(msg.sender);
        account.collateral += cbtcAmount;
        emit Deposited(msg.sender, cbtcAmount);

        if (jusdAmount == 0) return;

        // Lock in the current rate on each mint
        account.fixedAnnualRatePPM = RATE.currentRatePPM() + riskPremiumPPM;

        // Check mint ceiling
        uint256 maxMintable = (account.collateral * mintCeiling) / ONE_DEC18;
        if (account.principal + jusdAmount > maxMintable) {
            revert ExceedsCeiling(jusdAmount, maxMintable - account.principal);
        }

        account.principal += jusdAmount;
        totalMinted += jusdAmount;

        JUSD.mintWithReserve(msg.sender, jusdAmount, reservePPM);
        emit Minted(msg.sender, jusdAmount);
    }

    /**
     * @notice Repay JUSD debt. Interest is paid first, then principal.
     * @param amount JUSD amount to repay.
     */
    function repay(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();

        Account storage account = accounts[msg.sender];
        _accrueInterest(msg.sender);

        uint256 debt = account.principal + account.interest;
        if (amount > debt) revert InsufficientRepayment(amount, debt);

        // Pay interest first
        if (account.interest > 0) {
            uint256 interestPayment = amount < account.interest ? amount : account.interest;
            JUSD.collectProfits(msg.sender, interestPayment);
            account.interest -= interestPayment;
            amount -= interestPayment;
        }

        // Then pay principal
        if (amount > 0) {
            JUSD.burnFromWithReserve(msg.sender, amount, reservePPM);
            account.principal -= amount;
            totalMinted -= amount;
        }

        emit Repaid(msg.sender, amount);
    }

    /**
     * @notice Withdraw cBTC collateral. Only possible if remaining collateral
     *         still covers the outstanding principal at the current mint ceiling.
     * @param amount Amount of cBTC to withdraw.
     * @param asNative If true, unwrap cBTC to native coin.
     */
    function withdraw(uint256 amount, bool asNative) external {
        if (amount == 0) revert ZeroAmount();

        Account storage account = accounts[msg.sender];
        _accrueInterest(msg.sender);

        if (amount > account.collateral) {
            revert InsufficientCollateral(amount, account.collateral);
        }

        // Check that remaining collateral still covers principal at ceiling price
        uint256 remainingCollateral = account.collateral - amount;
        uint256 maxMintable = (remainingCollateral * mintCeiling) / ONE_DEC18;
        if (account.principal > maxMintable) {
            revert InsufficientCollateral(amount, account.collateral - (account.principal * ONE_DEC18 + mintCeiling - 1) / mintCeiling);
        }

        account.collateral -= amount;

        if (asNative && address(cBTC) == WCBTC) {
            IWrappedNative(WCBTC).withdraw(amount);
            (bool success, ) = msg.sender.call{value: amount}("");
            if (!success) revert NativeTransferFailed();
        } else {
            cBTC.transfer(msg.sender, amount);
        }

        emit Withdrawn(msg.sender, amount);
    }

    /**
     * @notice Repay all debt and withdraw all collateral in one transaction.
     * @param asNative If true, return cBTC as native coin.
     */
    function repayAllAndWithdraw(bool asNative) external {
        Account storage account = accounts[msg.sender];
        _accrueInterest(msg.sender);

        uint256 interestOwed = account.interest;
        uint256 principalOwed = account.principal;
        uint256 collateralToReturn = account.collateral;

        // Pay interest
        if (interestOwed > 0) {
            JUSD.collectProfits(msg.sender, interestOwed);
            account.interest = 0;
        }

        // Pay principal
        if (principalOwed > 0) {
            JUSD.burnFromWithReserve(msg.sender, principalOwed, reservePPM);
            totalMinted -= principalOwed;
            account.principal = 0;
        }

        // Withdraw collateral
        if (collateralToReturn > 0) {
            account.collateral = 0;

            if (asNative && address(cBTC) == WCBTC) {
                IWrappedNative(WCBTC).withdraw(collateralToReturn);
                (bool success, ) = msg.sender.call{value: collateralToReturn}("");
                if (!success) revert NativeTransferFailed();
            } else {
                cBTC.transfer(msg.sender, collateralToReturn);
            }
        }

        emit Repaid(msg.sender, principalOwed + interestOwed);
        emit Withdrawn(msg.sender, collateralToReturn);
    }

    // ========== VIEW FUNCTIONS ==========

    /**
     * @notice Returns the total debt (principal + accrued interest) for an account.
     */
    function getDebt(address owner) external view returns (uint256 principal_, uint256 interest_) {
        Account memory account = accounts[owner];
        principal_ = account.principal;
        interest_ = _calculateInterest(account);
    }

    /**
     * @notice Returns how much additional JUSD can be minted by an account.
     */
    function availableToMint(address owner) external view returns (uint256) {
        Account memory account = accounts[owner];
        uint256 maxMintable = (account.collateral * mintCeiling) / ONE_DEC18;
        return account.principal >= maxMintable ? 0 : maxMintable - account.principal;
    }

    /**
     * @notice Returns how much collateral can be withdrawn by an account.
     */
    function availableToWithdraw(address owner) external view returns (uint256) {
        Account memory account = accounts[owner];
        if (account.principal == 0) return account.collateral;
        uint256 requiredCollateral = (account.principal * ONE_DEC18 + mintCeiling - 1) / mintCeiling;
        return account.collateral > requiredCollateral ? account.collateral - requiredCollateral : 0;
    }

    // ========== GOVERNANCE ==========

    /**
     * @notice Propose a new mint ceiling. Requires 2% governance quorum.
     *         Takes effect after CEILING_CHANGE_DELAY.
     * @param newCeiling New max JUSD per 1e18 cBTC.
     * @param helpers Addresses that delegated their votes to the caller.
     */
    function proposeMintCeiling(uint256 newCeiling, address[] calldata helpers) external {
        IReserve reserve = JUSD.reserve();
        reserve.checkQualified(msg.sender, helpers);

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
     * @dev Requires 10% governance power. Once stopped, no new deposits or mints.
     *      Users can still repay and withdraw.
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

    // ========== INTERNAL ==========

    /**
     * @notice Accrue interest on an account since the last accrual.
     */
    function _accrueInterest(address owner) internal {
        Account storage account = accounts[owner];
        uint256 newInterest = _calculateInterest(account);

        if (newInterest > account.interest) {
            account.interest = newInterest;
        }

        account.lastAccrual = uint40(block.timestamp);
    }

    /**
     * @notice Calculate total outstanding interest for an account.
     * @dev Interest is calculated only on the usable principal (what user received, not reserve portion).
     *      Formula matches Position.sol: principal * (1M - reservePPM) * rate * delta / (365d * 1M * 1M)
     */
    function _calculateInterest(Account memory account) internal view returns (uint256) {
        uint256 newInterest = account.interest;

        if (block.timestamp > account.lastAccrual && account.principal > 0) {
            uint256 delta = block.timestamp - account.lastAccrual;
            newInterest +=
                (account.principal * (1_000_000 - reservePPM) * account.fixedAnnualRatePPM * delta) /
                (365 days * 1_000_000 * 1_000_000);
        }

        return newInterest;
    }

    /**
     * @notice Required to receive native coin when unwrapping WcBTC.
     */
    receive() external payable {}
}
