// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {MintingHub} from "../MintingHubV2/MintingHub.sol";

/**
 * @title MockFailingHub
 * @notice A test contract that inherits from MintingHub but always reverts on event forwarding.
 * @dev Used to test that Position operations succeed even when hub event forwarding fails.
 */
contract MockFailingHub is MintingHub {
    error HubEventForwardingDisabled();

    constructor(
        address _jusd,
        address _leadrate,
        address payable _roller,
        address _positionFactory,
        address _wcbtc
    ) MintingHub(_jusd, _leadrate, _roller, _positionFactory, _wcbtc) {}

    /**
     * @notice Override to always revert - simulates hub failure.
     */
    function emitPositionUpdate(uint256, uint256, uint256) external view override {
        revert HubEventForwardingDisabled();
    }

    /**
     * @notice Override to always revert - simulates hub failure.
     */
    function emitPositionDenied(address, string calldata) external view override {
        revert HubEventForwardingDisabled();
    }
}
