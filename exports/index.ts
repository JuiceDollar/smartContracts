// Chain addresses
export * from "./address.config";

// Shared ABIs (version-independent)
export * from "./abis/shared/JuiceDollar";
export * from "./abis/shared/Equity";
export * from "./abis/shared/StablecoinBridge";

// V2 ABIs (deployed on mainnet, permanent reference)
export * from "./abis/v2/PositionFactoryV2";
export * from "./abis/v2/PositionRoller";
export * from "./abis/v2/PositionV2";
export * from "./abis/v2/MintingHubGateway";
export * from "./abis/v2/FrontendGateway";
export * from "./abis/v2/SavingsGateway";
export * from "./abis/v2/SavingsVaultJUSD";

// V3.1 ABIs (new contracts)
export * from "./abis/v3_1/MintingHub";
export * from "./abis/v3_1/Position";
export * from "./abis/v3_1/PositionFactory";
export * from "./abis/v3_1/PositionRoller";
export * from "./abis/v3_1/Savings";
export * from "./abis/v3_1/SavingsVaultJUSD";

// Utility ABIs
export * from "./abis/utils/ERC20";
export * from "./abis/utils/ERC20PermitLight";
export * from "./abis/utils/Ownable";
export * from "./abis/utils/Leadrate";
export * from "./abis/utils/UniswapV3Pool";
export * from "./abis/utils/StartUSD";
