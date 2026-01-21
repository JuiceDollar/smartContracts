import { getAddress } from 'ethers';

export const ADDRESSES: Record<number, { WCBTC: string, JUICESWAP_ROUTER: string, JUICESWAP_FACTORY: string, USDC_E?: string, USDT_E?: string }> = {
  5115: {
    WCBTC: '0x8d0c9d1c17aE5e40ffF9bE350f57840E9E66Cd93',
    JUICESWAP_ROUTER: '',
    JUICESWAP_FACTORY: '',
    USDC_E: '0xE045e6c36cF77FAA2CfB54466D71A3aEF7bbE839',
    USDT_E: '0x9f3096Bac87e7F03DC09b0B416eB0DF837304dc4',
  },
  1337: {
    // localhost - addresses will be set dynamically via environment variables during testing
    WCBTC: '',
    JUICESWAP_ROUTER: '',
    JUICESWAP_FACTORY: '',
  },
  31337: {
    // hardhat network - addresses will be set dynamically via environment variables during testing
    WCBTC: '',
    JUICESWAP_ROUTER: '',
    JUICESWAP_FACTORY: '',
  },
};

// optional runtime validation to catch typos early
Object.values(ADDRESSES).forEach((obj) => {
  Object.values(obj).forEach((a) => a ? getAddress(a) : null);
});
