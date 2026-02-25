import { getFullDeployment } from '../scripts/utils/deployments';
import { formatHash } from '../scripts/utils/utils';
import { task } from 'hardhat/config';

task('get-contracts', 'Get JuiceDollar Protocol Contract Addresses on Citrea').setAction(
  async ({}) => {
    const protocolDeployment = getFullDeployment();

    console.log(`Network:     ${protocolDeployment.network}`);
    console.log(`Deployer:    ${formatHash(protocolDeployment.deployer, true, 'address', false)}`);
    console.log(`Timestamp:   ${new Date(protocolDeployment.timestamp * 1000).toLocaleString('de-DE')}`);
    console.log();

    const contracts = Object.entries(protocolDeployment.contracts);
    const maxNameLen = Math.max(...contracts.map(([name]) => name.length));

    for (const [name, data] of contracts.sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`  ${name.padEnd(maxNameLen)}  ${data.address}`);
    }

    console.log();
  },
);
