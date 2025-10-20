import { ethers, TransactionRequest } from 'ethers';
import { FlashbotsBundleProvider, FlashbotsBundleResolution } from '@flashbots/ethers-provider-bundle';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { flashbotsConfig, contractsParams } from '../config/flashbotsConfig';
import JuiceDollarArtifact from '../../../artifacts/contracts/JuiceDollar.sol/JuiceDollar.json';
import PositionFactoryArtifact from '../../../artifacts/contracts/MintingHubV2/PositionFactory.sol/PositionFactory.json';
import PositionRollerArtifact from '../../../artifacts/contracts/MintingHubV2/PositionRoller.sol/PositionRoller.json';
import StablecoinBridgeArtifact from '../../../artifacts/contracts/StablecoinBridge.sol/StablecoinBridge.json';
import DEPSWrapperArtifact from '../../../artifacts/contracts/utils/DEPSWrapper.sol/DEPSWrapper.json';
import FrontendGatewayArtifact from '../../../artifacts/contracts/gateway/FrontendGateway.sol/FrontendGateway.json';
import SavingsGatewayArtifact from '../../../artifacts/contracts/gateway/SavingsGateway.sol/SavingsGateway.json';
import MintingHubGatewayArtifact from '../../../artifacts/contracts/gateway/MintingHubGateway.sol/MintingHubGateway.json';

dotenv.config();

interface FlashbotsBundleTransaction {
  signedTransaction?: string;
  signer: any;
  transaction: TransactionRequest;
}

interface DeployedContract {
  address: string;
  constructorArgs?: any[];
}

interface DeployedContracts {
  juiceDollar: DeployedContract;
  equity: DeployedContract;
  positionFactory: DeployedContract;
  positionRoller: DeployedContract;
  bridgeUSDC: DeployedContract;
  depsWrapper: DeployedContract;
  frontendGateway: DeployedContract;
  savingsGateway: DeployedContract;
  mintingHubGateway: DeployedContract;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(`https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_RPC_KEY}`, 1);
  const network = await provider.getNetwork();
  const chainId = network.chainId;
  console.log(`Deploying on ${network.name} (chainId: ${chainId})`);

  const deployer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY!, provider);
  console.log(`Using deployer address: ${deployer.address}`);

  if (!process.env.FLASHBOTS_AUTH_KEY) {
    throw new Error('FLASHBOTS_AUTH_KEY environment variable is required');
  }

  // Setup Flashbots provider and define target block
  const flashbotsProvider = await FlashbotsBundleProvider.create(
    provider,
    new ethers.Wallet(process.env.FLASHBOTS_AUTH_KEY),
  );
  const blockNumber = await provider.getBlockNumber();
  const targetBlock = blockNumber + flashbotsConfig.targetBlockOffset;
  let nonce = await provider.getTransactionCount(deployer.address);
  console.log(`Starting deployment targeting block ${targetBlock}`);
  console.log(`Current nonce: ${nonce}`);

  const transactionBundle: FlashbotsBundleTransaction[] = [];

  // Add coinbase payment transaction if configured
  if (flashbotsConfig.coinbasePayment) {
    const block = await provider.getBlock('latest');
    if (block && block.miner) {
      const coinbasePaymentTx: TransactionRequest = {
        to: block.miner,
        value: ethers.parseEther(flashbotsConfig.coinbasePayment),
        gasLimit: 21000,
        chainId: chainId,
        type: 2, // EIP-1559
        maxFeePerGas: ethers.parseUnits(flashbotsConfig.maxFeePerGas, 'gwei'),
        maxPriorityFeePerGas: ethers.parseUnits(flashbotsConfig.maxPriorityFeePerGas, 'gwei'),
        nonce: nonce++,
      };

      transactionBundle.push({
        transaction: coinbasePaymentTx,
        signer: deployer,
      });

      console.log(`Added coinbase payment of ${flashbotsConfig.coinbasePayment} ETH to ${block.miner}`);
    } else {
      console.warn('Could not get latest block miner, skipping coinbase payment');
    }
  }

  // Track contract deployment metadata
  async function createDeployTx(contractName: string, artifact: any, constructorArgs: any[] = []) {
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);
    const txRequest = await factory.getDeployTransaction(...constructorArgs);

    const deployTx: TransactionRequest = {
      to: null,
      data: txRequest.data,
      value: txRequest.value || 0,
      gasLimit: ethers.parseUnits(flashbotsConfig.contractDeploymentGasLimit, 'wei'),
      chainId: chainId,
      type: 2, // EIP-1559
      maxFeePerGas: ethers.parseUnits(flashbotsConfig.maxFeePerGas, 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits(flashbotsConfig.maxPriorityFeePerGas, 'gwei'),
      nonce: nonce++,
    };

    transactionBundle.push({
      transaction: deployTx,
      signer: deployer,
    });

    // Calculate deployed contract address
    const address = ethers.getCreateAddress({
      from: deployer.address,
      nonce: deployTx.nonce!,
    });

    console.log(`${contractName} will be deployed at: ${address}`);
    return {
      address,
      constructorArgs,
    };
  }

  // Track contract call metadata
  async function createCallTx(contractAddress: string, abi: any, functionName: string, args: any[]) {
    const contract = new ethers.Contract(contractAddress, abi, deployer);
    const data = contract.interface.encodeFunctionData(functionName, args);

    const callTx: TransactionRequest = {
      to: contractAddress,
      data,
      value: 0,
      gasLimit: ethers.parseUnits(flashbotsConfig.contractCallGasLimit, 'wei'),
      chainId: chainId,
      type: 2, // EIP-1559
      maxFeePerGas: ethers.parseUnits(flashbotsConfig.maxFeePerGas, 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits(flashbotsConfig.maxPriorityFeePerGas, 'gwei'),
      nonce: nonce++,
    };

    transactionBundle.push({
      transaction: callTx,
      signer: deployer,
    });

    return callTx;
  }

  // Deploy all contracts
  console.log('Setting up contract deployment transactions...');

  const juiceDollar = await createDeployTx('JuiceDollar', JuiceDollarArtifact, [
    contractsParams.juiceDollar.minApplicationPeriod,
  ]);

  // Calculate equity address (first contract deployed internally => nonce = 1)
  const equity = {
    address: ethers.getCreateAddress({ from: juiceDollar.address, nonce: 1 }),
    constructorArgs: [juiceDollar.address],
  };
  console.log('Equity address will be deployed at: ', equity.address);

  const positionFactory = await createDeployTx('PositionFactory', PositionFactoryArtifact);

  const positionRoller = await createDeployTx('PositionRoller', PositionRollerArtifact, [juiceDollar.address]);

  const depsWrapper = await createDeployTx('DEPSWrapper', DEPSWrapperArtifact, [equity.address]);

  const bridgeUSDC = await createDeployTx('StablecoinBridgeUSDC', StablecoinBridgeArtifact, [
    contractsParams.bridges.usdc.other,
    juiceDollar.address,
    contractsParams.bridges.usdc.limit,
    contractsParams.bridges.usdc.weeks,
  ]);

  // Deploy FrontendGateway
  const frontendGateway = await createDeployTx('FrontendGateway', FrontendGatewayArtifact, [
    juiceDollar.address,
    depsWrapper.address,
  ]);

  // Deploy SavingsGateway
  const savingsGateway = await createDeployTx('SavingsGateway', SavingsGatewayArtifact, [
    juiceDollar.address,
    contractsParams.savingsGateway.initialRatePPM,
    frontendGateway.address,
  ]);

  // Deploy MintingHubGateway
  const mintingHubGateway = await createDeployTx('MintingHubGateway', MintingHubGatewayArtifact, [
    juiceDollar.address,
    savingsGateway.address,
    positionRoller.address,
    positionFactory.address,
    frontendGateway.address,
  ]);

  const deployedContracts: DeployedContracts = {
    juiceDollar,
    equity,
    positionFactory,
    positionRoller,
    bridgeUSDC,
    depsWrapper,
    frontendGateway,
    savingsGateway,
    mintingHubGateway,
  };

  // Setup initialization transactions
  console.log('Setting up initialization transactions...');

  // Initialize FrontendGateway
  createCallTx(frontendGateway.address, FrontendGatewayArtifact.abi, 'init', [
    savingsGateway.address,
    mintingHubGateway.address,
  ]);

  // Initialize minters in JuiceDollar
  createCallTx(juiceDollar.address, JuiceDollarArtifact.abi, 'initialize', [
    mintingHubGateway.address,
    'MintingHubGateway',
  ]);

  createCallTx(juiceDollar.address, JuiceDollarArtifact.abi, 'initialize', [
    positionRoller.address,
    'PositionRoller',
  ]);

  createCallTx(juiceDollar.address, JuiceDollarArtifact.abi, 'initialize', [
    savingsGateway.address,
    'SavingsGateway',
  ]);

  createCallTx(juiceDollar.address, JuiceDollarArtifact.abi, 'initialize', [
    frontendGateway.address,
    'FrontendGateway',
  ]);

  if (bridgeUSDC) {
    createCallTx(juiceDollar.address, JuiceDollarArtifact.abi, 'initialize', [
      bridgeUSDC.address,
      'StablecoinBridgeUSDC',
    ]);
  }

  // Approve and mint 1000 JUSD through the USDC bridge to close initialization phase
  const usdcAmount = ethers.parseUnits('1000', 6); // USDC has 6 decimals
  createCallTx(
    contractsParams.bridges.usdc.other,
    ['function approve(address spender, uint256 amount) external returns (bool)'],
    'approve',
    [bridgeUSDC.address, usdcAmount],
  );

  createCallTx(bridgeUSDC.address, StablecoinBridgeArtifact.abi, 'mint', [usdcAmount]);

  // Approve and invest 1000 JUSD in Equity to mint the initial 10_000_000 JUICE
  const JUSDInvestAmount = ethers.parseUnits('1000', 18); // JUSD has 18 decimals
  const expectedShares = ethers.parseUnits('10000000', 18); // JUICE has 18 decimals
  
  createCallTx(
    juiceDollar.address,
    JuiceDollarArtifact.abi,
    'approve',
    [equity.address, JUSDInvestAmount],
  );

  createCallTx(
    equity.address,
    ['function invest(uint256 amount, uint256 expectedShares) external returns (uint256)'],
    'invest',
    [JUSDInvestAmount, expectedShares],
  );

  // Submit the bundle to Flashbots
  let bundleSubmitted = false;
  console.log(`Submitting bundle (${transactionBundle.length} TXs) to Flashbots. Target block: ${targetBlock}...`);

  try {
    const bundleResponse = await flashbotsProvider.sendBundle(transactionBundle, targetBlock);

    // Check if there's an error with the response
    if ('error' in bundleResponse) {
      console.error(`Error with bundle: ${bundleResponse.error.message}`);
      process.exit(1);
    }

    // Simulate the bundle to check for issues
    const signedTransactions = await flashbotsProvider.signBundle(transactionBundle);
    const simulation = await flashbotsProvider.simulate(signedTransactions, targetBlock);

    if ('error' in simulation) {
      console.error(`Simulation error: ${simulation.error.message}`);
      process.exit(1);
    }

    // Wait for bundle inclusion
    console.log(`Bundle simulated successfully. Estimated gas used: ${simulation.totalGasUsed}`);
    console.log(`Effective gas price: ${simulation.bundleGasPrice}`);
    console.log(`Waiting for bundle inclusion...`);
    const waitResponse = await bundleResponse.wait();

    if (waitResponse === FlashbotsBundleResolution.BundleIncluded) {
      console.log('Bundle was included in the target block!');
      bundleSubmitted = true;
    } else if (waitResponse === FlashbotsBundleResolution.BlockPassedWithoutInclusion) {
      console.log('Bundle was not included in the target block');
    } else if (waitResponse === FlashbotsBundleResolution.AccountNonceTooHigh) {
      console.error('Bundle not included - account nonce too high');
    }
  } catch (error) {
    console.error('Error submitting Flashbots bundle:', error);
  }

  if (!bundleSubmitted) {
    console.error('Failed to submit bundle. Exiting...');
    process.exit(1);
  }

  // Save deployment metadata to file
  console.log('Saving deployment metadata to file...');
  const deploymentInfo = {
    network: (await provider.getNetwork()).name,
    blockNumber: targetBlock,
    deployer: deployer.address,
    contracts: deployedContracts,
    timestamp: Date.now(),
  };

  const deploymentDir = path.join(__dirname, '../../deployments');
  if (!fs.existsSync(deploymentDir)) {
    fs.mkdirSync(deploymentDir, { recursive: true });
  }

  fs.writeFileSync(
    path.join(deploymentDir, `deployProtocol-${Date.now()}.json`),
    JSON.stringify(deploymentInfo, null, 2),
  );

  console.log('\n✅ Deployment completed successfully!');
  console.log(JSON.stringify(deployedContracts, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Deployment error:', error);
    process.exit(1);
  });
