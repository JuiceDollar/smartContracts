import { ethers } from 'hardhat';
import hre from 'hardhat';
import fs from 'fs';
import path from 'path';

/**
 * @title JuiceDollar Protocol Deployment Script
 * @notice Deploys the complete JuiceDollar protocol for Citrea
 * @dev This script replaces the old Flashbots-based deployment which is not compatible with Citrea
 *
 * Deployment Order:
 * 1. JuiceDollar (which internally deploys Equity)
 * 2. PositionFactory
 * 3. PositionRoller
 * 4. StablecoinBridge (USDT)
 * 5. FrontendGateway
 * 6. SavingsGateway
 * 7. MintingHubGateway
 * 8. Initialize all minters and gateways
 */

interface DeployedContract {
  address: string;
  constructorArgs?: any[];
}

interface DeployedContracts {
  juiceDollar: DeployedContract;
  equity: DeployedContract;
  positionFactory: DeployedContract;
  positionRoller: DeployedContract;
  bridgeUSDT?: DeployedContract;
  frontendGateway: DeployedContract;
  savingsGateway: DeployedContract;
  mintingHubGateway: DeployedContract;
}

interface DeploymentConfig {
  juiceDollar: {
    minApplicationPeriod: number;
  };
  savingsGateway: {
    initialRatePPM: bigint;
  };
  bridges: {
    usdt?: {
      tokenAddress: string;
      limitAmount: string;
      durationWeeks: number;
    };
  };
}

async function main() {
  console.log('\n🚀 JuiceDollar Protocol Deployment');
  console.log('=====================================\n');

  // Get network info
  const networkName = hre.network.name;
  const chainId = (await ethers.provider.getNetwork()).chainId;
  console.log(`Network: ${networkName} (Chain ID: ${chainId})`);

  // Get deployer
  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance: ${ethers.formatEther(balance)} ${networkName.includes('citrea') ? 'cBTC' : 'ETH'}`);

  // Load configuration
  const config = getNetworkConfig(networkName);
  console.log('\n📋 Configuration:');
  console.log(`  Min Application Period: ${config.juiceDollar.minApplicationPeriod}s (${config.juiceDollar.minApplicationPeriod / 86400} days)`);
  console.log(`  Initial Savings Rate: ${config.savingsGateway.initialRatePPM} PPM`);
  if (config.bridges.usdt) {
    console.log(`  USDT Bridge: ${config.bridges.usdt.tokenAddress}`);
    console.log(`  Bridge Limit: ${ethers.formatUnits(config.bridges.usdt.limitAmount, 18)} JUSD`);
  }

  const deployedContracts: Partial<DeployedContracts> = {};

  // ============================================
  // STEP 1: Deploy JuiceDollar (+ Equity)
  // ============================================
  console.log('\n📦 Step 1: Deploying JuiceDollar...');
  const JuiceDollarFactory = await ethers.getContractFactory('JuiceDollar');
  const juiceDollar = await JuiceDollarFactory.deploy(config.juiceDollar.minApplicationPeriod);
  await juiceDollar.waitForDeployment();
  const juiceDollarAddress = await juiceDollar.getAddress();
  console.log(`✅ JuiceDollar deployed at: ${juiceDollarAddress}`);

  deployedContracts.juiceDollar = {
    address: juiceDollarAddress,
    constructorArgs: [config.juiceDollar.minApplicationPeriod],
  };

  // Get Equity address (deployed internally by JuiceDollar constructor)
  const equityAddress = await juiceDollar.reserve();
  console.log(`✅ Equity deployed at: ${equityAddress}`);
  deployedContracts.equity = {
    address: equityAddress,
    constructorArgs: [juiceDollarAddress],
  };

  // ============================================
  // STEP 2: Deploy PositionFactory
  // ============================================
  console.log('\n📦 Step 2: Deploying PositionFactory...');
  const PositionFactoryFactory = await ethers.getContractFactory('PositionFactory');
  const positionFactory = await PositionFactoryFactory.deploy();
  await positionFactory.waitForDeployment();
  const positionFactoryAddress = await positionFactory.getAddress();
  console.log(`✅ PositionFactory deployed at: ${positionFactoryAddress}`);

  deployedContracts.positionFactory = {
    address: positionFactoryAddress,
    constructorArgs: [],
  };

  // ============================================
  // STEP 3: Deploy PositionRoller
  // ============================================
  console.log('\n📦 Step 3: Deploying PositionRoller...');
  const PositionRollerFactory = await ethers.getContractFactory('PositionRoller');
  const positionRoller = await PositionRollerFactory.deploy(juiceDollarAddress);
  await positionRoller.waitForDeployment();
  const positionRollerAddress = await positionRoller.getAddress();
  console.log(`✅ PositionRoller deployed at: ${positionRollerAddress}`);

  deployedContracts.positionRoller = {
    address: positionRollerAddress,
    constructorArgs: [juiceDollarAddress],
  };

  // ============================================
  // STEP 4: Deploy StablecoinBridge (USDT) - Optional
  // ============================================
  let bridgeUSDTAddress: string | undefined;
  if (config.bridges.usdt && config.bridges.usdt.tokenAddress !== '0x0000000000000000000000000000000000000000') {
    console.log('\n📦 Step 4: Deploying StablecoinBridge (USDT)...');
    const StablecoinBridgeFactory = await ethers.getContractFactory('StablecoinBridge');
    const bridgeUSDT = await StablecoinBridgeFactory.deploy(
      config.bridges.usdt.tokenAddress,
      juiceDollarAddress,
      config.bridges.usdt.limitAmount,
      config.bridges.usdt.durationWeeks,
    );
    await bridgeUSDT.waitForDeployment();
    bridgeUSDTAddress = await bridgeUSDT.getAddress();
    console.log(`✅ StablecoinBridge (USDT) deployed at: ${bridgeUSDTAddress}`);

    deployedContracts.bridgeUSDT = {
      address: bridgeUSDTAddress,
      constructorArgs: [
        config.bridges.usdt.tokenAddress,
        juiceDollarAddress,
        config.bridges.usdt.limitAmount,
        config.bridges.usdt.durationWeeks,
      ],
    };
  } else {
    console.log('\n⏭️  Step 4: Skipping StablecoinBridge (USDT) - No token address configured');
  }

  // ============================================
  // STEP 5: Deploy FrontendGateway
  // ============================================
  console.log('\n📦 Step 5: Deploying FrontendGateway...');
  const FrontendGatewayFactory = await ethers.getContractFactory('FrontendGateway');
  const frontendGateway = await FrontendGatewayFactory.deploy(
    juiceDollarAddress,
    ethers.ZeroAddress, // No leadrate contract initially
  );
  await frontendGateway.waitForDeployment();
  const frontendGatewayAddress = await frontendGateway.getAddress();
  console.log(`✅ FrontendGateway deployed at: ${frontendGatewayAddress}`);

  deployedContracts.frontendGateway = {
    address: frontendGatewayAddress,
    constructorArgs: [juiceDollarAddress, ethers.ZeroAddress],
  };

  // ============================================
  // STEP 6: Deploy SavingsGateway
  // ============================================
  console.log('\n📦 Step 6: Deploying SavingsGateway...');
  const SavingsGatewayFactory = await ethers.getContractFactory('SavingsGateway');
  const savingsGateway = await SavingsGatewayFactory.deploy(
    juiceDollarAddress,
    config.savingsGateway.initialRatePPM,
    frontendGatewayAddress,
  );
  await savingsGateway.waitForDeployment();
  const savingsGatewayAddress = await savingsGateway.getAddress();
  console.log(`✅ SavingsGateway deployed at: ${savingsGatewayAddress}`);

  deployedContracts.savingsGateway = {
    address: savingsGatewayAddress,
    constructorArgs: [juiceDollarAddress, config.savingsGateway.initialRatePPM, frontendGatewayAddress],
  };

  // ============================================
  // STEP 7: Deploy MintingHubGateway
  // ============================================
  console.log('\n📦 Step 7: Deploying MintingHubGateway...');
  const MintingHubGatewayFactory = await ethers.getContractFactory('MintingHubGateway');
  const mintingHubGateway = await MintingHubGatewayFactory.deploy(
    juiceDollarAddress,
    savingsGatewayAddress,
    positionRollerAddress,
    positionFactoryAddress,
    frontendGatewayAddress,
  );
  await mintingHubGateway.waitForDeployment();
  const mintingHubGatewayAddress = await mintingHubGateway.getAddress();
  console.log(`✅ MintingHubGateway deployed at: ${mintingHubGatewayAddress}`);

  deployedContracts.mintingHubGateway = {
    address: mintingHubGatewayAddress,
    constructorArgs: [
      juiceDollarAddress,
      savingsGatewayAddress,
      positionRollerAddress,
      positionFactoryAddress,
      frontendGatewayAddress,
    ],
  };

  // ============================================
  // STEP 8: Initialize Contracts
  // ============================================
  console.log('\n⚙️  Step 8: Initializing contracts...');

  // 8.1: Initialize FrontendGateway
  console.log('  → Initializing FrontendGateway...');
  const tx1 = await frontendGateway.init(savingsGatewayAddress, mintingHubGatewayAddress);
  await tx1.wait();
  console.log('  ✅ FrontendGateway initialized');

  // 8.2: Initialize JuiceDollar minters
  console.log('  → Registering minters in JuiceDollar...');

  const tx2 = await juiceDollar.initialize(mintingHubGatewayAddress, 'MintingHubGateway');
  await tx2.wait();
  console.log('  ✅ MintingHubGateway registered as minter');

  const tx3 = await juiceDollar.initialize(positionRollerAddress, 'PositionRoller');
  await tx3.wait();
  console.log('  ✅ PositionRoller registered as minter');

  const tx4 = await juiceDollar.initialize(savingsGatewayAddress, 'SavingsGateway');
  await tx4.wait();
  console.log('  ✅ SavingsGateway registered as minter');

  const tx5 = await juiceDollar.initialize(frontendGatewayAddress, 'FrontendGateway');
  await tx5.wait();
  console.log('  ✅ FrontendGateway registered as minter');

  if (bridgeUSDTAddress) {
    const tx6 = await juiceDollar.initialize(bridgeUSDTAddress, 'StablecoinBridgeUSDT');
    await tx6.wait();
    console.log('  ✅ StablecoinBridgeUSDT registered as minter');
  }

  // ============================================
  // STEP 9: Bootstrap Protocol (Optional)
  // ============================================
  console.log('\n🌱 Step 9: Bootstrap protocol...');

  if (bridgeUSDTAddress && config.bridges.usdt) {
    console.log('  → Minting 1000 JUSD through USDT bridge to close initialization phase...');

    // Note: This requires the deployer to have USDT
    // In production, this should be done manually after verifying the deployment
    console.log('  ⚠️  Manual step required:');
    console.log(`     1. Approve USDT: ${config.bridges.usdt.tokenAddress}`);
    console.log(`     2. Bridge address: ${bridgeUSDTAddress}`);
    console.log(`     3. Amount: 1000 USDT (6 decimals)`);
    console.log(`     4. Call bridge.mint(1000000000) to mint 1000 JUSD`);
    console.log(`     5. Approve 1000 JUSD to Equity: ${equityAddress}`);
    console.log(`     6. Call equity.invest(1000e18, 10000000e18) to mint initial JUICE`);
  } else {
    console.log('  ⚠️  No USDT bridge configured. Manual initialization required:');
    console.log(`     1. Deploy a position or bridge to mint initial JUSD`);
    console.log(`     2. Invest 1000 JUSD in Equity to mint 10_000_000 JUICE`);
  }

  // ============================================
  // STEP 10: Save Deployment Info
  // ============================================
  console.log('\n💾 Step 10: Saving deployment metadata...');

  const deploymentInfo = {
    network: networkName,
    chainId: Number(chainId),
    blockNumber: await ethers.provider.getBlockNumber(),
    deployer: deployer.address,
    timestamp: Date.now(),
    contracts: deployedContracts as DeployedContracts,
    config,
  };

  const deploymentDir = path.join(__dirname, '../../deployments');
  if (!fs.existsSync(deploymentDir)) {
    fs.mkdirSync(deploymentDir, { recursive: true });
  }

  const filename = `deployProtocol-${networkName}-${Date.now()}.json`;
  const filepath = path.join(deploymentDir, filename);
  fs.writeFileSync(filepath, JSON.stringify(deploymentInfo, null, 2));
  console.log(`✅ Deployment info saved to: ${filename}`);

  // ============================================
  // STEP 11: Verify Contracts (if not local network)
  // ============================================
  if (networkName !== 'hardhat' && networkName !== 'localhost') {
    console.log('\n🔍 Step 11: Verifying contracts on block explorer...');
    console.log('  Waiting 30 seconds for block explorer to index...');
    await new Promise((resolve) => setTimeout(resolve, 30000));

    try {
      await verifyContract('JuiceDollar', juiceDollarAddress, [config.juiceDollar.minApplicationPeriod]);
      await verifyContract('PositionFactory', positionFactoryAddress, []);
      await verifyContract('PositionRoller', positionRollerAddress, [juiceDollarAddress]);
      if (bridgeUSDTAddress && config.bridges.usdt) {
        await verifyContract('StablecoinBridge', bridgeUSDTAddress, [
          config.bridges.usdt.tokenAddress,
          juiceDollarAddress,
          config.bridges.usdt.limitAmount,
          config.bridges.usdt.durationWeeks,
        ]);
      }
      await verifyContract('FrontendGateway', frontendGatewayAddress, [juiceDollarAddress, ethers.ZeroAddress]);
      await verifyContract('SavingsGateway', savingsGatewayAddress, [
        juiceDollarAddress,
        config.savingsGateway.initialRatePPM,
        frontendGatewayAddress,
      ]);
      await verifyContract('MintingHubGateway', mintingHubGatewayAddress, [
        juiceDollarAddress,
        savingsGatewayAddress,
        positionRollerAddress,
        positionFactoryAddress,
        frontendGatewayAddress,
      ]);
    } catch (error) {
      console.log('  ⚠️  Some contracts failed to verify. You can verify them manually later.');
    }
  }

  // ============================================
  // FINAL SUMMARY
  // ============================================
  console.log('\n✅ ========================================');
  console.log('✅  DEPLOYMENT COMPLETED SUCCESSFULLY!');
  console.log('✅ ========================================\n');

  console.log('📋 Deployed Contracts:');
  console.log(`  JuiceDollar:        ${juiceDollarAddress}`);
  console.log(`  Equity (JUICE):     ${equityAddress}`);
  console.log(`  PositionFactory:    ${positionFactoryAddress}`);
  console.log(`  PositionRoller:     ${positionRollerAddress}`);
  if (bridgeUSDTAddress) {
    console.log(`  BridgeUSDT:         ${bridgeUSDTAddress}`);
  }
  console.log(`  FrontendGateway:    ${frontendGatewayAddress}`);
  console.log(`  SavingsGateway:     ${savingsGatewayAddress}`);
  console.log(`  MintingHubGateway:  ${mintingHubGatewayAddress}`);

  console.log('\n📝 Next Steps:');
  console.log('  1. Update exports/address.config.ts with deployed addresses');
  console.log('  2. Run yarn run ts:export:abis to generate TypeScript ABIs');
  console.log('  3. Bootstrap the protocol by minting initial JUSD and JUICE');
  console.log('  4. Deploy positions using scripts/deployment/deploy/deployPositions.ts');
  console.log('  5. Update documentation with deployment addresses');

  return deployedContracts;
}

// Helper function to get network-specific configuration
function getNetworkConfig(networkName: string): DeploymentConfig {
  const configs: Record<string, DeploymentConfig> = {
    citrea: {
      juiceDollar: {
        minApplicationPeriod: 10 * 86400, // 10 days
      },
      savingsGateway: {
        initialRatePPM: 0n, // 0% initial rate
      },
      bridges: {
        usdt: {
          tokenAddress: '0x0000000000000000000000000000000000000000', // TODO: Add Citrea USDT address
          limitAmount: ethers.parseUnits('1000000', 18).toString(), // 1M JUSD limit
          durationWeeks: 52, // 1 year
        },
      },
    },
    citreaTestnet: {
      juiceDollar: {
        minApplicationPeriod: 3 * 86400, // 3 days for testnet
      },
      savingsGateway: {
        initialRatePPM: 0n, // 0% initial rate
      },
      bridges: {
        usdt: {
          tokenAddress: '0x0000000000000000000000000000000000000000', // TODO: Add Citrea Testnet USDT address
          limitAmount: ethers.parseUnits('100000', 18).toString(), // 100K JUSD limit for testnet
          durationWeeks: 52,
        },
      },
    },
    hardhat: {
      juiceDollar: {
        minApplicationPeriod: 10 * 86400,
      },
      savingsGateway: {
        initialRatePPM: 0n,
      },
      bridges: {},
    },
    localhost: {
      juiceDollar: {
        minApplicationPeriod: 10 * 86400,
      },
      savingsGateway: {
        initialRatePPM: 0n,
      },
      bridges: {},
    },
  };

  return configs[networkName] || configs.hardhat;
}

// Helper function to verify contracts
async function verifyContract(name: string, address: string, constructorArguments: any[]) {
  try {
    console.log(`  → Verifying ${name}...`);
    await hre.run('verify:verify', {
      address,
      constructorArguments,
    });
    console.log(`  ✅ ${name} verified`);
  } catch (error: any) {
    if (error.message.includes('Already Verified')) {
      console.log(`  ✅ ${name} already verified`);
    } else {
      console.log(`  ❌ ${name} verification failed: ${error.message}`);
    }
  }
}

// Execute deployment
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('\n❌ Deployment failed:', error);
      process.exit(1);
    });
}

export default main;
