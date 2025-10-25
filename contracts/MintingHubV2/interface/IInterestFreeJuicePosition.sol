// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IPosition} from "./IPosition.sol";

/**
 * @title IInterestFreeJuicePosition
 * @notice Interface for an interest-free position that automatically invests minted JUSD into JUICE tokens.
 * JUICE tokens remain locked in the contract and cannot be transferred, but can be sold back to JUSD.
 */
interface IInterestFreeJuicePosition is IPosition {
    /**
     * @notice Emitted when JUICE is automatically purchased during minting
     * @param jusdAmount Amount of JUSD invested
     * @param juiceReceived Amount of JUICE tokens received
     */
    event JuiceInvested(uint256 jusdAmount, uint256 juiceReceived);

    /**
     * @notice Emitted when JUICE is sold back to JUSD
     * @param juiceAmount Amount of JUICE sold
     * @param jusdReceived Amount of JUSD received
     * @param loanReduction Amount of loan repaid
     */
    event JuiceSold(uint256 juiceAmount, uint256 jusdReceived, uint256 loanReduction);

    /**
     * @notice Returns the amount of JUICE tokens held by this position
     * @return The JUICE token balance
     */
    function juiceBalance() external view returns (uint256);

    /**
     * @notice Returns the current value of held JUICE in JUSD terms
     * @return The estimated JUSD value of all JUICE holdings
     */
    function getJuiceValue() external view returns (uint256);

    /**
     * @notice Sells JUICE tokens back to JUSD and automatically repays the loan
     * @param juiceAmount Amount of JUICE to sell
     * @param minJusdReceived Minimum acceptable JUSD amount (slippage protection)
     * @return jusdReceived The actual amount of JUSD received from the sale
     */
    function sellJuice(uint256 juiceAmount, uint256 minJusdReceived) external returns (uint256 jusdReceived);

    /**
     * @notice Transfer all JUICE to another InterestFreeJuicePosition
     * @dev Only callable by owner or roller, used for position rolling
     * @param target The target InterestFreeJuicePosition to receive the JUICE
     */
    function transferJuice(address target) external;

    /**
     * @notice Delegate the voting power of the JUICE held by this contract to another address
     * @dev Only callable by the position owner
     * @param delegate The address to delegate voting power to
     */
    function delegateJuiceVotingPower(address delegate) external;

    /**
     * @notice Returns whether this position charges interest
     * @return Always returns false for interest-free positions
     */
    function isInterestFree() external pure returns (bool);
}
