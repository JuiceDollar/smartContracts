// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IJuiceDollar} from "./interface/IJuiceDollar.sol";
import {IReserve} from "./interface/IReserve.sol";
import {Leadrate} from "./Leadrate.sol";
import {AbstractSavings} from "./abstract/AbstractSavings.sol";

/**
 * @title Savings
 *
 * Module to enable savings based on a Leadrate ("Leitzins") module.
 *
 * As the interest rate changes, the speed at which 'ticks' are accumulated is
 * adjusted. The ticks counter serves as the basis for calculating the interest
 * due for the individual accounts.
 *
 * This contract combines both Leadrate (governance for rate changes) and AbstractSavings
 * (user savings accounts) into a single module.
 */
contract Savings is Leadrate, AbstractSavings {

    constructor(IJuiceDollar jusd_, uint24 initialRatePPM)
        AbstractSavings(IERC20(jusd_))
        Leadrate(IReserve(jusd_.reserve()), initialRatePPM)
    {
    }

    /**
     * Override to check if module will be disabled soon.
     */
    function save(address owner, uint192 amount) public override {
        if (currentRatePPM == 0) revert ModuleDisabled();
        if (nextRatePPM == 0 && (nextChange <= block.timestamp)) revert ModuleDisabled();
        super.save(owner, amount);
    }

}
