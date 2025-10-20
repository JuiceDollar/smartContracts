import { mainnet, polygon } from "viem/chains";
import { Address, zeroAddress } from "viem";

export interface ChainAddress {
  juiceDollar: Address;
  equity: Address;
  frontendGateway: Address;
  savingsGateway: Address;
  savingsVaultJUSD: Address;
  mintingHubGateway: Address;
  coinLendingGateway: Address;
  DEPSwrapper: Address;
  bridgeUSDC: Address;
  usdc: Address;
  roller: Address;
  positionFactoryV2: Address;
}

export const ADDRESS: Record<number, ChainAddress> = {
  [mainnet.id]: {
    // native contract addresses
    juiceDollar: "0xbA3f535bbCcCcA2A154b573Ca6c5A49BAAE0a3ea",
    equity: "0xc71104001A3CCDA1BEf1177d765831Bd1bfE8eE6",
    frontendGateway: "0x5c49C00f897bD970d964BFB8c3065ae65a180994",
    savingsGateway: "0x073493d73258C4BEb6542e8dd3e1b2891C972303",
    savingsVaultJUSD: "0x1e9f008B1C538bE32F190516735bF1C634B4FA40",
    mintingHubGateway: "0x8B3c41c649B9c7085C171CbB82337889b3604618",
    coinLendingGateway: "0x1DA37D613FB590eeD37520b72e9c6F0F6eee89D2",
    DEPSwrapper: "0x103747924E74708139a9400e4Ab4BEA79FFFA380",
    bridgeUSDC: zeroAddress, // Template bridge - update with actual address when deployed
    usdc: zeroAddress, // Template USD token - update with actual address when deployed
    roller: "0x4CE0AB2FC21Bd27a47A64F594Fdf7654Ea57Dc79",
    positionFactoryV2: "0x167144d66AC1D02EAAFCa3649ef3305ea31Ee5A8",
  },
};
