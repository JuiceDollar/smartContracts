// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

/**
 * @title ICoinLendingGateway
 * @notice Interface for the Coin Lending Gateway contract
 */
interface ICoinLendingGateway {
    /**
     * @notice Emitted when a position is created with native coins
     * @param owner The owner of the newly created position
     * @param position The address of the newly created position
     * @param coinAmount The amount of native coin used as collateral
     * @param mintAmount The amount of JUSD minted
     * @param liquidationPrice The liquidation price set for the position
     */
    event PositionCreatedWithCoin(
        address indexed owner,
        address indexed position,
        uint256 coinAmount,
        uint256 mintAmount,
        uint256 liquidationPrice
    );

    /**
     * @notice Creates a lending position using native coins in a single transaction
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
    ) external payable returns (address position);

    /**
     * @notice Creates a lending position for another owner using native coins
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
    ) external payable returns (address position);

    /**
     * @notice Emitted when collateral is added to a position with native coins
     * @param position The address of the position
     * @param amount The amount of native coin added as collateral
     */
    event CollateralAddedWithCoin(address indexed position, uint256 amount);

    /**
     * @notice Emitted when WcBTC is withdrawn as native coins
     * @param to The recipient of the native coins
     * @param amount The amount of native coins withdrawn
     */
    event CollateralWithdrawnToCoin(address indexed to, uint256 amount);

    /**
     * @notice Emitted when a position is closed and collateral is returned as native coins
     * @param owner The owner of the position
     * @param position The address of the closed position
     * @param collateralAmount The amount of native coins returned
     * @param repayAmount The amount of JUSD repaid
     */
    event PositionClosedToCoin(address indexed owner, address indexed position, uint256 collateralAmount, uint256 repayAmount);

    /**
     * @notice Adds collateral to an existing position using native coins
     * @param position The address of the position to add collateral to
     */
    function addCollateralWithCoin(address position) external payable;

    /**
     * @notice Withdraws WcBTC and returns native coins to the caller
     * @dev User must first approve WcBTC spending by this contract
     * @param amount The amount of WcBTC to unwrap and withdraw as native coins
     */
    function withdrawToCoin(uint256 amount) external;

    /**
     * @notice Closes a position and returns all collateral as native coins in a single transaction
     * @dev The caller must first transfer ownership of the position to this contract.
     *      The caller must also approve JUSD spending by this contract.
     *      After closing, ownership is transferred back to the caller.
     * @param position The address of the position to close
     * @param repayAmount The amount of JUSD to repay (should cover full debt including interest)
     */
    function closePositionToCoin(address position, uint256 repayAmount) external;

    /**
     * @notice Closes a position and returns all collateral as native coins using ERC20Permit for gasless approval
     * @dev The caller must first transfer ownership of the position to this contract.
     *      Instead of a separate approve transaction, the caller provides a permit signature.
     *      After closing, ownership is transferred back to the caller.
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
    ) external;

    /**
     * @notice Rescue function to withdraw accidentally sent native coins
     */
    function rescueCoin() external;

    /**
     * @notice Rescue function to withdraw accidentally sent tokens
     * @param token The address of the token to rescue
     * @param to The address to send the tokens to
     * @param amount The amount of tokens to rescue
     */
    function rescueToken(address token, address to, uint256 amount) external;
}