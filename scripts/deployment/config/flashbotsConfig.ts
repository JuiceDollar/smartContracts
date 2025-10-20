export interface FlashbotsConfig {
  maxFeePerGas: string; // in gwei
  maxPriorityFeePerGas: string; // in gwei
  contractDeploymentGasLimit: string;
  contractCallGasLimit: string;
  targetBlockOffset: number;
  coinbasePayment?: string; // in ETH
  maxRetries?: number;
  retryDelayMs?: number;
}

export interface StablecoinBridgeParams {
  other: string;
  limit: string; // in JUSD
  weeks: number;
  applicationMsg: string;
}

export interface ContractsParams {
  juiceDollar: {
    minApplicationPeriod: number;
  };
  savingsGateway: {
    initialRatePPM: number;
  };
  bridges: {
    usdc: StablecoinBridgeParams;
  };
}

export const flashbotsConfig: FlashbotsConfig = {
  maxFeePerGas: '30',
  maxPriorityFeePerGas: '5',
  contractDeploymentGasLimit: '8000000',
  contractCallGasLimit: '500000',
  targetBlockOffset: 1,
  coinbasePayment: '0.05',  // Pay miners 0.05 ETH to include the bundle
};

export const contractsParams = {
  juiceDollar: {
    minApplicationPeriod: 1209600,
  },
  savingsGateway: {
    initialRatePPM: 100000,
  },
  bridges: {
    usdc: {
      other: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC on mainnet
      limit: '1000000000000000000000000',
      weeks: 30,
      applicationMsg: 'USDC Bridge',
    },
  },
};
