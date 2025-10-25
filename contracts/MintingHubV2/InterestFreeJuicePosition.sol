// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {Position} from "./Position.sol";
import {IPosition} from "./interface/IPosition.sol";
import {IInterestFreeJuicePosition} from "./interface/IInterestFreeJuicePosition.sol";
import {Equity} from "../Equity.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title InterestFreeJuicePosition
 * @notice A specialized position that offers interest-free loans by automatically investing minted JUSD into JUICE tokens.
 *
 * Key Features:
 * - Interest-free loans (0% interest, but reserve contribution fees still apply)
 * - Automatic JUICE investment upon minting
 * - JUICE tokens remain locked in the contract (non-transferable)
 * - Partial JUICE selling allowed
 * - Position ownership is transferable
 * - Standard challenge/liquidation mechanics apply
 *
 * Flow:
 * 1. User deposits WcBTC collateral
 * 2. User mints JUSD (interest-free)
 * 3. JUSD is automatically invested into JUICE
 * 4. JUICE remains locked in this contract
 * 5. User can sell JUICE back to JUSD to reduce/repay loan
 * 6. Position ownership can be transferred
 */
contract InterestFreeJuicePosition is Position, IInterestFreeJuicePosition {
    /**
     * @notice The JUICE token (Equity) contract
     */
    Equity public immutable JUICE;

    /**
     * @notice Minimum JUICE to keep for gas optimization (1 wei)
     */
    uint256 private constant MIN_JUICE_BALANCE = 1;

    error InsufficientJuiceBalance(uint256 requested, uint256 available);
    error SlippageExceeded(uint256 received, uint256 minimum);
    error ZeroAmount();

    /**
     * @notice Constructor for InterestFreeJuicePosition
     * @dev Inherits all parameters from Position but forces zero interest rate
     */
    constructor(
        address _owner,
        address _hub,
        address _jusd,
        address _collateral,
        uint256 _minCollateral,
        uint256 _initialLimit,
        uint40 _initPeriod,
        uint40 _duration,
        uint40 _challengePeriod,
        uint24 _riskPremiumPPM,  // Will be ignored, always set to 0
        uint256 _liqPrice,
        uint24 _reservePPM
    )
        Position(
            _owner,
            _hub,
            _jusd,
            _collateral,
            _minCollateral,
            _initialLimit,
            _initPeriod,
            _duration,
            _challengePeriod,
            0, // Force zero risk premium
            _liqPrice,
            _reservePPM
        )
    {
        JUICE = Equity(address(jusd.reserve()));

        // Override the fixed rate to zero (interest-free)
        // This is set in the parent constructor via _fixRateToLeadrate, but we override it here
        fixedAnnualRatePPM = 0;
    }

    /**
     * @notice Mints JUSD and automatically invests it into JUICE tokens
     * @dev Overrides the parent mint function to add automatic JUICE investment
     * @param target The address that will own the position (JUICE stays in contract)
     * @param amount The amount of JUSD to mint
     */
    function mint(address target, uint256 amount) public override(Position, IPosition) ownerOrRoller {
        if (amount == 0) revert ZeroAmount();

        // Get collateral balance before minting
        uint256 collateralBalance = _collateralBalance();

        // Call parent _mint which handles all position logic
        // This mints JUSD to this contract address
        _mint(address(this), amount, collateralBalance);

        // Calculate usable amount after reserve contribution
        uint256 usableAmount = getUsableMint(amount);

        // Approve JUICE contract to spend our JUSD
        require(jusd.approve(address(JUICE), usableAmount), "Approval failed");

        // Invest JUSD into JUICE
        // The JUICE tokens will be minted to this contract and remain locked here
        uint256 juiceReceived = JUICE.invest(usableAmount, 0);

        emit JuiceInvested(usableAmount, juiceReceived);
        emit MintingUpdate(collateralBalance, price, principal);
    }

    /**
     * @notice Sells JUICE tokens back to JUSD and automatically repays the loan
     * @param juiceAmount The amount of JUICE to sell
     * @param minJusdReceived Minimum acceptable JUSD (slippage protection)
     * @return jusdReceived The actual amount of JUSD received
     */
    function sellJuice(
        uint256 juiceAmount,
        uint256 minJusdReceived
    ) external override onlyOwner returns (uint256 jusdReceived) {
        if (juiceAmount == 0) revert ZeroAmount();

        uint256 currentJuiceBalance = juiceBalance();
        if (juiceAmount > currentJuiceBalance) {
            revert InsufficientJuiceBalance(juiceAmount, currentJuiceBalance);
        }

        // Redeem JUICE for JUSD
        jusdReceived = JUICE.redeem(address(this), juiceAmount);

        // Check slippage
        if (jusdReceived < minJusdReceived) {
            revert SlippageExceeded(jusdReceived, minJusdReceived);
        }

        // Automatically repay the loan with received JUSD
        // Since JUSD is now in this contract, we need to handle the repayment
        uint256 loanReduction = _repayLoanFromContract(jusdReceived);

        emit JuiceSold(juiceAmount, jusdReceived, loanReduction);
        emit MintingUpdate(_collateralBalance(), price, principal);

        return jusdReceived;
    }

    /**
     * @notice Repays loan using JUSD held by this contract
     * @dev Similar to _payDownDebt but uses contract's JUSD balance instead of msg.sender
     * @param amount Maximum amount to repay
     * @return used Amount of JUSD actually used for repayment
     */
    function _repayLoanFromContract(uint256 amount) internal returns (uint256) {
        _accrueInterest();
        if (amount == 0) return 0;

        uint256 remaining = amount;

        // Repay interest first
        uint256 interestPayment = (interest > remaining) ? remaining : interest;
        if (interestPayment > 0) {
            jusd.collectProfits(address(this), interestPayment);
            _notifyInterestPaid(interestPayment);
            remaining -= interestPayment;
        }

        // Then repay principal
        uint256 principalPayment = (principal > remaining) ? remaining : principal;
        if (principalPayment > 0) {
            uint256 returnedReserve = jusd.burnFromWithReserve(address(this), principalPayment, reserveContribution);
            _notifyRepaid(principalPayment);
            remaining -= (principalPayment - returnedReserve);
        }

        return amount - remaining;
    }

    /**
     * @notice Returns the JUICE balance held by this position
     */
    function juiceBalance() public view override returns (uint256) {
        return JUICE.balanceOf(address(this));
    }

    /**
     * @notice Returns the current value of held JUICE in JUSD terms
     * @dev Uses the Equity contract's calculateProceeds function
     */
    function getJuiceValue() external view override returns (uint256) {
        uint256 balance = juiceBalance();
        if (balance == 0) return 0;
        return JUICE.calculateProceeds(balance);
    }

    /**
     * @notice Override initialize to ensure clones remain interest-free
     * @dev Clones must also have 0% interest rate
     */
    function initialize(address parent, uint40 _expiration) external override(Position, IPosition) onlyHub {
        if (expiration != 0) revert AlreadyInitialized();
        if (_expiration < block.timestamp || _expiration > Position(original).expiration()) revert InvalidExpiration();
        expiration = _expiration;
        price = Position(parent).price();
        // Keep interest rate at 0 (do NOT call _fixRateToLeadrate)
        fixedAnnualRatePPM = 0;
        _transferOwnership(hub);
    }

    /**
     * @notice Transfer all JUICE to another InterestFreeJuicePosition
     * @dev Only callable by owner or roller, used for position rolling
     * @dev Target MUST be an InterestFreeJuicePosition contract (not EOA!)
     * @param target The target InterestFreeJuicePosition to receive the JUICE
     */
    function transferJuice(address target) external ownerOrRoller {
        require(target != address(0), "Invalid target");

        // Ensure target is a contract (not EOA)
        require(target.code.length > 0, "Target must be a contract");

        // Verify target is an InterestFreeJuicePosition
        // This prevents transferring JUICE to user wallets or other contracts
        try InterestFreeJuicePosition(target).isInterestFree() returns (bool isInterestFree) {
            require(isInterestFree, "Target must be InterestFreeJuicePosition");
        } catch {
            revert("Target must be InterestFreeJuicePosition");
        }

        uint256 balance = juiceBalance();
        if (balance > 0) {
            // Transfer JUICE to target position
            JUICE.transfer(target, balance);
        }
    }

    /**
     * @notice Returns whether this position charges interest
     * @return Always returns false for interest-free positions
     */
    function isInterestFree() external pure override returns (bool) {
        return true;
    }
}
