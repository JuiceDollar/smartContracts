// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title RejectEther
 * @notice Test helper contract that rejects all native coin transfers
 * @dev Used to test NativeTransferFailed error in Position.withdrawCollateralAsNative()
 */
contract RejectEther {
    receive() external payable {
        revert("I reject ether");
    }

    fallback() external payable {
        revert("I reject ether");
    }
}
