import { HDNodeWallet } from "ethers";

/**
 * Derive Ethereum addresses from an xpub (extended public key)
 *
 * The xpub should be at account level: m/44'/60'/0'
 * This script derives non-hardened paths: /0/index
 */

const xpub = "xpub6BwaZN3hXzmuokodcrSaRYT9BKRZzzAC1eXfPvop3wQP8nE5wsCdssL7DmSRNMRGaXihoPhpSPbngfpHhAJ4sz3NdUURnBkkBa6w25aWxMU";

async function main() {
  console.log("Deriving addresses from xpub...\n");
  console.log(`xpub: ${xpub}\n`);

  // Create HD node from xpub (at account level m/44'/60'/0')
  const accountNode = HDNodeWallet.fromExtendedKey(xpub);

  // Derive deployer address (index 0)
  console.log("═".repeat(60));
  console.log("DEPLOYER (index 0)");
  console.log("═".repeat(60));
  const deployerNode = accountNode.derivePath("0/0");
  console.log(`Path:    m/44'/60'/0'/0/0`);
  console.log(`Address: ${deployerNode.address}`);
  console.log("");

  // Derive batch investor addresses (index 100-139)
  console.log("═".repeat(60));
  console.log("BATCH INVESTORS (index 100-139)");
  console.log("═".repeat(60));

  const batchInvestors: { index: number; path: string; address: string }[] = [];

  for (let i = 0; i < 40; i++) {
    const index = 100 + i;
    const path = `0/${index}`;
    const node = accountNode.derivePath(path);

    batchInvestors.push({
      index,
      path: `m/44'/60'/0'/0/${index}`,
      address: node.address,
    });

    console.log(`Investor ${String(i + 1).padStart(2, " ")}: ${node.address}  (index ${index})`);
  }

  console.log("");
  console.log("═".repeat(60));
  console.log("SUMMARY");
  console.log("═".repeat(60));
  console.log(`Deployer:        ${deployerNode.address}`);
  console.log(`Batch Investors: ${batchInvestors.length} addresses (index 100-139)`);
  console.log("");

  // Output as JSON for easy copy
  console.log("═".repeat(60));
  console.log("JSON OUTPUT");
  console.log("═".repeat(60));
  const output = {
    deployer: {
      index: 0,
      path: "m/44'/60'/0'/0/0",
      address: deployerNode.address,
    },
    batchInvestors,
  };
  console.log(JSON.stringify(output, null, 2));
}

main().catch(console.error);
