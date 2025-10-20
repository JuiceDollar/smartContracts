export interface StablecoinBridgeConfig {
  name: string;
  sourceToken: string;    // Address of source stablecoin
  limitAmount: string;    // Max mint amount in JUSD
  durationWeeks: number;
  description: string;
}

export const bridgeConfigs: Record<string, StablecoinBridgeConfig> = {
  USDC: {
    name: "StablecoinBridgeUSDC",
    sourceToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC on mainnet
    limitAmount: "100000", // 100'000 limit
    durationWeeks: 26,
    description: "USDC Bridge"
  }
};
