import { ethers } from "hardhat";
import { floatToDec18 } from "../../utils/math";

/**
 * Deploy an InterestFreeJuicePosition
 *
 * This script deploys a new InterestFreeJuicePosition contract.
 * The position offers interest-free (0% interest) loans by automatically investing minted JUSD into JUICE.
 * Note: Reserve contribution fees (15%) still apply - only the interest is zero!
 *
 * Usage:
 * npx hardhat run scripts/deployment/deploy/deployInterestFreeJuicePosition.ts --network citrea
 */

async function main() {
  console.log("Deploying InterestFreeJuicePosition...");

  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  // Configuration - Update these values before deployment
  const config = {
    owner: deployer.address, // Position owner
    hub: "", // TODO: Add MintingHub address
    jusd: "", // TODO: Add JuiceDollar address
    collateral: "", // TODO: Add WcBTC address
    minCollateral: floatToDec18(0.01), // 0.01 WcBTC minimum
    initialLimit: floatToDec18(10_000_000), // 10M JUSD max
    initPeriod: 3 * 86400, // 3 days initialization period
    duration: 180 * 86400, // 180 days (6 months)
    challengePeriod: 2 * 86400, // 2 days challenge period
    riskPremiumPPM: 0, // 0% (zero-fee position)
    liqPrice: floatToDec18(90_000), // $90k liquidation price
    reservePPM: 150_000, // 15% reserve requirement
  };

  // Validate configuration
  if (!config.hub || config.hub === "") {
    throw new Error("Please set the MintingHub address in the config");
  }
  if (!config.jusd || config.jusd === "") {
    throw new Error("Please set the JuiceDollar address in the config");
  }
  if (!config.collateral || config.collateral === "") {
    throw new Error("Please set the WcBTC collateral address in the config");
  }

  console.log("\nDeployment Configuration:");
  console.log("Owner:", config.owner);
  console.log("MintingHub:", config.hub);
  console.log("JuiceDollar:", config.jusd);
  console.log("Collateral (WcBTC):", config.collateral);
  console.log("Min Collateral:", config.minCollateral.toString());
  console.log("Initial Limit:", config.initialLimit.toString());
  console.log("Risk Premium PPM:", config.riskPremiumPPM);
  console.log("Reserve PPM:", config.reservePPM);

  // Deploy InterestFreeJuicePosition
  const InterestFreeJuicePositionFactory = await ethers.getContractFactory(
    "InterestFreeJuicePosition"
  );

  const interestFreePosition = await InterestFreeJuicePositionFactory.deploy(
    config.owner,
    config.hub,
    config.jusd,
    config.collateral,
    config.minCollateral,
    config.initialLimit,
    config.initPeriod,
    config.duration,
    config.challengePeriod,
    config.riskPremiumPPM,
    config.liqPrice,
    config.reservePPM
  );

  await interestFreePosition.waitForDeployment();

  const address = await interestFreePosition.getAddress();
  console.log("\n✅ InterestFreeJuicePosition deployed to:", address);

  // Verify the deployment
  const fixedRate = await interestFreePosition.fixedAnnualRatePPM();
  const isInterestFree = await interestFreePosition.isInterestFree();

  console.log("\nDeployment Verification:");
  console.log("Fixed Annual Rate PPM:", fixedRate.toString(), "(should be 0)");
  console.log("Is Zero Fee:", isInterestFree, "(should be true)");

  if (fixedRate !== 0n) {
    console.error("⚠️  WARNING: Fixed rate is not zero!");
  }

  console.log("\n📝 Next Steps:");
  console.log(
    "1. Register the position contract code with MintingHub using:"
  );
  console.log(
    `   mintingHub.registerPosition(await ethers.provider.getCode("${address}"))`
  );
  console.log("2. Wait for the initialization period (3 days)");
  console.log("3. Deposit collateral to the position");
  console.log("4. Start minting JUSD and auto-investing in JUICE!");

  return {
    interestFreePosition: address,
    fixedRate,
    isInterestFree,
  };
}

// Execute deployment
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
