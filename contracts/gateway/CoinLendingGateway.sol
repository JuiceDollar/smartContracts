// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import {IMintingHubGateway} from "./interface/IMintingHubGateway.sol";
import {ICoinLendingGateway} from "./interface/ICoinLendingGateway.sol";
import {IPosition} from "../MintingHubV2/interface/IPosition.sol";
import {IJuiceDollar} from "../interface/IJuiceDollar.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

interface IWrappedCBTC is IERC20 {
    function deposit() external payable;
    function withdraw(uint256 wad) external;
}

/**
 * @title Coin Lending Gateway
 * @notice An improved gateway that enables true single-transaction native coin lending with custom liquidation prices
 * @dev This version handles the ownership transfer timing issue to allow price adjustments in the same transaction
 */
contract CoinLendingGateway is ICoinLendingGateway, Ownable, ReentrancyGuard, Pausable {
    IMintingHubGateway public immutable MINTING_HUB;
    IWrappedCBTC public immutable WCBTC;
    IJuiceDollar public immutable JUSD;

    error InsufficientCoin();
    error InvalidPosition();
    error TransferFailed();
    error PriceAdjustmentFailed();
    error DirectCBTCNotAccepted();
    error InsufficientWcBTC();

    event CoinRescued(address indexed to, uint256 amount);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    /**
     * @notice Initializes the Coin Lending Gateway
     * @param _mintingHub The address of the MintingHubGateway contract
     * @param _wcbtc The address of the Wrapped cBTC (WcBTC) token contract
     * @param _jusd The address of the JuiceDollar contract
     */
    constructor(address _mintingHub, address _wcbtc, address _jusd) Ownable(_msgSender()) {
        MINTING_HUB = IMintingHubGateway(_mintingHub);
        WCBTC = IWrappedCBTC(_wcbtc);
        JUSD = IJuiceDollar(_jusd);
    }

    /**
     * @notice Creates a lending position using native cBTC in a single transaction
     * @dev This improved version uses a two-step clone process to handle ownership and price adjustment correctly
     * @param parent The parent position to clone from
     * @param initialMint The amount of JUSD to mint
     * @param expiration The expiration timestamp for the position
     * @param frontendCode The frontend referral code
     * @param liquidationPrice The desired liquidation price (0 to skip adjustment)
     * @return position The address of the newly created position
     */
    function lendWithCoin(
        address parent,
        uint256 initialMint,
        uint40 expiration,
        bytes32 frontendCode,
        uint256 liquidationPrice
    ) external payable nonReentrant whenNotPaused returns (address position) {
        if (msg.value == 0) revert InsufficientCoin();

        return _lendWithCoin(
            _msgSender(),
            parent,
            initialMint,
            expiration,
            frontendCode,
            liquidationPrice
        );
    }

    /**
     * @notice Creates a lending position for another owner using native cBTC
     * @dev Same as lendWithCoin but allows specifying a different owner
     * @param owner The address that will own the position
     * @param parent The parent position to clone from
     * @param initialMint The amount of JUSD to mint
     * @param expiration The expiration timestamp for the position
     * @param frontendCode The frontend referral code
     * @param liquidationPrice The desired liquidation price (0 to skip adjustment)
     * @return position The address of the newly created position
     */
    function lendWithCoinFor(
        address owner,
        address parent,
        uint256 initialMint,
        uint40 expiration,
        bytes32 frontendCode,
        uint256 liquidationPrice
    ) external payable nonReentrant whenNotPaused returns (address position) {
        if (msg.value == 0) revert InsufficientCoin();
        if (owner == address(0)) revert InvalidPosition();

        return _lendWithCoin(
            owner,
            parent,
            initialMint,
            expiration,
            frontendCode,
            liquidationPrice
        );
    }

    /**
     * @dev Internal function containing the core lending logic
     * @param owner The address that will own the position
     * @param parent The parent position to clone from
     * @param initialMint The amount of JUSD to mint
     * @param expiration The expiration timestamp for the position
     * @param frontendCode The frontend referral code
     * @param liquidationPrice The desired liquidation price (0 to skip adjustment)
     * @return position The address of the newly created position
     */
    function _lendWithCoin(
        address owner,
        address parent,
        uint256 initialMint,
        uint40 expiration,
        bytes32 frontendCode,
        uint256 liquidationPrice
    ) internal returns (address position) {
        WCBTC.deposit{value: msg.value}();

        WCBTC.approve(address(MINTING_HUB), msg.value);

        // This contract must be initial owner to call adjustPrice before transferring ownership
        position = MINTING_HUB.clone(
            address(this),   // temporary owner (this contract)
            parent,          // parent position
            msg.value,       // collateral amount
            initialMint,     // mint amount
            expiration,
            frontendCode
        );

        if (position == address(0)) revert InvalidPosition();

        if (liquidationPrice > 0) {
            uint256 currentPrice = IPosition(position).price();

            if (liquidationPrice != currentPrice) {
                try IPosition(position).adjustPrice(liquidationPrice) {
                    // Price adjustment succeeded
                } catch {
                    revert PriceAdjustmentFailed();
                }
            }
        }

        uint256 jusdBalance = JUSD.balanceOf(address(this));
        if (jusdBalance > 0) {
            JUSD.transfer(owner, jusdBalance);
        }

        Ownable(position).transferOwnership(owner);

        emit PositionCreatedWithCoin(
            owner,
            position,
            msg.value,
            initialMint,
            liquidationPrice
        );

        return position;
    }

    /**
     * @notice Adds collateral to an existing position using native cBTC
     * @dev Wraps cBTC to WcBTC and transfers it directly to the position
     * @param position The address of the position to add collateral to
     */
    function addCollateralWithCoin(address position) external payable nonReentrant whenNotPaused {
        if (msg.value == 0) revert InsufficientCoin();
        if (position == address(0)) revert InvalidPosition();

        // Wrap cBTC to WcBTC
        WCBTC.deposit{value: msg.value}();

        // Transfer WcBTC directly to the position
        bool success = WCBTC.transfer(position, msg.value);
        if (!success) revert TransferFailed();

        emit CollateralAddedWithCoin(position, msg.value);
    }

    /**
     * @notice Withdraws WcBTC and returns native cBTC to the caller
     * @dev User must first transfer WcBTC to this contract (e.g., via position.withdraw())
     *      then call this function to unwrap and receive native cBTC
     * @param amount The amount of WcBTC to unwrap and withdraw as native cBTC
     */
    function withdrawToCoin(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert InsufficientCoin();

        // Transfer WcBTC from caller to this contract
        bool success = WCBTC.transferFrom(_msgSender(), address(this), amount);
        if (!success) revert TransferFailed();

        // Unwrap WcBTC to native cBTC
        WCBTC.withdraw(amount);

        // Send native cBTC to caller
        (bool sent, ) = _msgSender().call{value: amount}("");
        if (!sent) revert TransferFailed();

        emit CollateralWithdrawnToCoin(_msgSender(), amount);
    }

    /**
     * @notice Closes a position and returns all collateral as native cBTC in a single transaction
     * @dev The caller must first transfer ownership of the position to this contract (via transferOwnership).
     *      The caller must also approve JUSD spending by this contract.
     *      This function will:
     *      1. Transfer JUSD from caller to repay the debt
     *      2. Withdraw all WcBTC collateral from the position
     *      3. Unwrap WcBTC to native cBTC
     *      4. Send native cBTC back to the caller
     *      5. Transfer ownership back to the caller
     * @param position The address of the position to close
     * @param repayAmount The amount of JUSD to repay (should cover full debt including interest)
     */
    function closePositionToCoin(address position, uint256 repayAmount) external nonReentrant whenNotPaused {
        if (position == address(0)) revert InvalidPosition();

        IPosition pos = IPosition(position);

        // Verify this contract is the position owner (user must have transferred ownership first)
        if (Ownable(position).owner() != address(this)) revert InvalidPosition();

        // Transfer JUSD from caller to this contract
        if (repayAmount > 0) {
            bool jusdTransferred = JUSD.transferFrom(_msgSender(), address(this), repayAmount);
            if (!jusdTransferred) revert TransferFailed();

            // Approve position to spend JUSD for repayment
            JUSD.approve(position, repayAmount);

            // Repay the debt
            pos.repay(repayAmount);
        }

        // Get the collateral balance of the position
        uint256 collateralBalance = WCBTC.balanceOf(position);

        if (collateralBalance > 0) {
            // Withdraw all collateral to this contract
            pos.withdrawCollateral(address(this), collateralBalance);

            // Unwrap WcBTC to native cBTC
            WCBTC.withdraw(collateralBalance);

            // Send native cBTC to caller
            (bool sent, ) = _msgSender().call{value: collateralBalance}("");
            if (!sent) revert TransferFailed();
        }

        // Return any excess JUSD to the caller (from rounding or overpayment)
        uint256 jusdBalance = JUSD.balanceOf(address(this));
        if (jusdBalance > 0) {
            JUSD.transfer(_msgSender(), jusdBalance);
        }

        // Transfer ownership back to the caller
        Ownable(position).transferOwnership(_msgSender());

        emit PositionClosedToCoin(_msgSender(), position, collateralBalance, repayAmount);
    }

    /**
     * @notice Closes a position and returns all collateral as native cBTC using ERC20Permit for gasless approval
     * @dev The caller must first transfer ownership of the position to this contract (via transferOwnership).
     *      Instead of a separate approve transaction, the caller provides a permit signature.
     *      This function will:
     *      1. Use permit to approve JUSD spending
     *      2. Transfer JUSD from caller to repay the debt
     *      3. Withdraw all WcBTC collateral from the position
     *      4. Unwrap WcBTC to native cBTC
     *      5. Send native cBTC back to the caller
     *      6. Transfer ownership back to the caller
     * @param position The address of the position to close
     * @param repayAmount The amount of JUSD to repay (should cover full debt including interest)
     * @param deadline The deadline for the permit signature
     * @param v The v component of the permit signature
     * @param r The r component of the permit signature
     * @param s The s component of the permit signature
     */
    function closePositionToCoinWithPermit(
        address position,
        uint256 repayAmount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant whenNotPaused {
        if (position == address(0)) revert InvalidPosition();

        IPosition pos = IPosition(position);

        // Verify this contract is the position owner (user must have transferred ownership first)
        if (Ownable(position).owner() != address(this)) revert InvalidPosition();

        // Use permit for gasless approval
        if (repayAmount > 0) {
            IERC20Permit(address(JUSD)).permit(_msgSender(), address(this), repayAmount, deadline, v, r, s);

            // Transfer JUSD from caller to this contract
            bool jusdTransferred = JUSD.transferFrom(_msgSender(), address(this), repayAmount);
            if (!jusdTransferred) revert TransferFailed();

            // Approve position to spend JUSD for repayment
            JUSD.approve(position, repayAmount);

            // Repay the debt
            pos.repay(repayAmount);
        }

        // Get the collateral balance of the position
        uint256 collateralBalance = WCBTC.balanceOf(position);

        if (collateralBalance > 0) {
            // Withdraw all collateral to this contract
            pos.withdrawCollateral(address(this), collateralBalance);

            // Unwrap WcBTC to native cBTC
            WCBTC.withdraw(collateralBalance);

            // Send native cBTC to caller
            (bool sent, ) = _msgSender().call{value: collateralBalance}("");
            if (!sent) revert TransferFailed();
        }

        // Return any excess JUSD to the caller (from rounding or overpayment)
        uint256 jusdBalance = JUSD.balanceOf(address(this));
        if (jusdBalance > 0) {
            JUSD.transfer(_msgSender(), jusdBalance);
        }

        // Transfer ownership back to the caller
        Ownable(position).transferOwnership(_msgSender());

        emit PositionClosedToCoin(_msgSender(), position, collateralBalance, repayAmount);
    }

    /**
     * @notice Rescue function to withdraw accidentally sent native cBTC
     * @dev Only owner can call this function
     */
    function rescueCoin() external onlyOwner {
        uint256 balance = address(this).balance;
        if (balance > 0) {
            (bool success, ) = owner().call{value: balance}("");
            if (!success) revert TransferFailed();
            emit CoinRescued(owner(), balance);
        }
    }

    /**
     * @notice Rescue function to withdraw accidentally sent tokens
     * @dev Only owner can call this function
     * @param token The address of the token to rescue
     * @param to The address to send the tokens to
     * @param amount The amount of tokens to rescue
     */
    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert TransferFailed();
        bool success = IERC20(token).transfer(to, amount);
        if (!success) revert TransferFailed();
        emit TokenRescued(token, to, amount);
    }

    /**
     * @notice Pause the contract (only owner)
     * @dev Prevents lendWithCoin functions from being called
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause the contract (only owner)
     * @dev Re-enables lendWithCoin functions
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @dev Accept cBTC only from WcBTC contract (for unwrapping), reject all others
     */
    receive() external payable {
        if (msg.sender != address(WCBTC)) {
            revert DirectCBTCNotAccepted();
        }
    }
}