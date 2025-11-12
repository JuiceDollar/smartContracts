import { getAddress } from 'ethers';

export const ADDRESSES: Record<number, { WCBTC: string, JUICESWAP_ROUTER: string, JUICESWAP_FACTORY: string }> = {
  5115: {
    WCBTC: '0x8d0c9d1c17aE5e40ffF9bE350f57840E9E66Cd93',
    JUICESWAP_ROUTER: '',
    JUICESWAP_FACTORY: '',
  },
};

// optional runtime validation to catch typos early
Object.values(ADDRESSES).forEach((obj) => {
  Object.values(obj).forEach((a) => a ? getAddress(a) : null);
});
