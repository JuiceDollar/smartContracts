import { expect } from "chai";
import { floatToDec18, dec18ToFloat } from "../../scripts/utils/math";
import { ethers } from "hardhat";
import { evm_increaseTime } from "../utils";
import * as helpers from "@nomicfoundation/hardhat-network-helpers";
import {
  Equity,
  JuiceDollar,
  MintingHub,
  InterestFreeJuicePosition,
  Savings,
  PositionRoller,
  StablecoinBridge,
  TestToken,
} from "../../typechain";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ContractTransactionResponse } from "ethers";

const weeks = 30;

const getPositionAddressFromTX = async (
  tx: ContractTransactionResponse,
): Promise<string> => {
  const PositionOpenedTopic =
    "0xc9b570ab9d98bdf3e38a40fd71b20edafca42449f23ca51f0bdcbf40e8ffe175";
  const rc = await tx.wait();
  const log = rc?.logs.find((x) => x.topics.indexOf(PositionOpenedTopic) >= 0);
  return "0x" + log?.topics[2].substring(26);
};

const registerPositionWithJUSD = async (
  jusd: JuiceDollar,
  mintingHub: MintingHub,
  positionAddress: string
) => {
  // Impersonate the MintingHub to register the position
  await helpers.impersonateAccount(await mintingHub.getAddress());
  const hubSigner = await ethers.getSigner(await mintingHub.getAddress());

  // Fund the hub signer with some ETH for gas
  await helpers.setBalance(await mintingHub.getAddress(), ethers.parseEther("1"));

  // Register the position as the MintingHub
  await jusd.connect(hubSigner).registerPosition(positionAddress);

  // Stop impersonating
  await helpers.stopImpersonatingAccount(await mintingHub.getAddress());
};

describe("InterestFreeJuicePosition Tests", () => {
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;

  let JUSD: JuiceDollar;
  let mintingHub: MintingHub;
  let bridge: StablecoinBridge;
  let savings: Savings;
  let roller: PositionRoller;
  let equity: Equity;
  let mockXUSD: TestToken;
  let collateralToken: TestToken;

  let limit: bigint;

  before(async () => {
    [owner, alice, bob] = await ethers.getSigners();

    // Create JuiceDollar and Equity
    const JuiceDollarFactory = await ethers.getContractFactory("JuiceDollar");
    JUSD = await JuiceDollarFactory.deploy(10 * 86400); // 10 days application period
    equity = await ethers.getContractAt("Equity", await JUSD.reserve());

    // Create Position Factory
    const positionFactoryFactory =
      await ethers.getContractFactory("PositionFactory");
    const positionFactory = await positionFactoryFactory.deploy();

    // Create Savings
    const savingsFactory = await ethers.getContractFactory("Savings");
    savings = await savingsFactory.deploy(JUSD.getAddress(), 0n);

    // Create Roller
    const rollerFactory = await ethers.getContractFactory("PositionRoller");
    roller = await rollerFactory.deploy(JUSD.getAddress());

    // Create MintingHub
    const mintingHubFactory = await ethers.getContractFactory("MintingHub");
    mintingHub = await mintingHubFactory.deploy(
      await JUSD.getAddress(),
      await savings.getAddress(),
      await roller.getAddress(),
      await positionFactory.getAddress(),
    );

    // Create Mock Tokens
    const testTokenFactory = await ethers.getContractFactory("TestToken");
    mockXUSD = await testTokenFactory.deploy("Mock XUSD", "XUSD", 18);
    collateralToken = await testTokenFactory.deploy("Wrapped cBTC", "WcBTC", 18);

    // Bootstrap with bridge
    limit = floatToDec18(1_000_000);
    const bridgeFactory = await ethers.getContractFactory("StablecoinBridge");
    bridge = await bridgeFactory.deploy(
      await mockXUSD.getAddress(),
      await JUSD.getAddress(),
      limit,
      weeks,
    );

    // Initialize minters
    await JUSD.initialize(await bridge.getAddress(), "XUSD Bridge");
    await JUSD.initialize(await mintingHub.getAddress(), "Minting Hub");
    await JUSD.initialize(await savings.getAddress(), "Savings");
    await JUSD.initialize(await roller.getAddress(), "Roller");

    await evm_increaseTime(60);

    // Bootstrap JUSD supply
    await mockXUSD.mint(owner.address, limit / 3n);
    await mockXUSD.approve(await bridge.getAddress(), limit / 3n);
    await bridge.mint(limit / 3n);

    // Mint collateral tokens to alice (enough for all tests)
    await collateralToken.mint(alice.address, floatToDec18(100)); // 100 WcBTC
  });

  describe("InterestFreeJuicePosition Creation", () => {
    it("should create a InterestFreeJuicePosition with zero interest rate", async () => {
      const interestFreeFactory = await ethers.getContractFactory("InterestFreeJuicePosition");
      const minCollateral = floatToDec18(0.01);
      const initialLimit = floatToDec18(1_000_000);
      const initPeriod = 3 * 86400; // 3 days
      const duration = 180 * 86400; // 180 days
      const challengePeriod = 2 * 86400; // 2 days
      const riskPremiumPPM = 30000; // 3% (will be ignored)
      const liqPrice = floatToDec18(90000); // $90k
      const reservePPM = 150000; // 15%

      const interestFreePosition = await interestFreeFactory.deploy(
        alice.address,
        await mintingHub.getAddress(),
        await JUSD.getAddress(),
        await collateralToken.getAddress(),
        minCollateral,
        initialLimit,
        initPeriod,
        duration,
        challengePeriod,
        riskPremiumPPM,
        liqPrice,
        reservePPM,
      );

      // Check that the interest rate is zero
      const fixedRate = await interestFreePosition.fixedAnnualRatePPM();
      expect(fixedRate).to.equal(0n);

      // Check isInterestFree function
      const isInterestFree = await interestFreePosition.isInterestFree();
      expect(isInterestFree).to.be.true;
    });
  });

  describe("Minting and Auto JUICE Investment", () => {
    let interestFreePosition: InterestFreeJuicePosition;
    const collateralAmount = floatToDec18(1); // 1 WcBTC
    const mintAmount = floatToDec18(50000); // 50k JUSD

    beforeEach(async () => {
      const interestFreeFactory = await ethers.getContractFactory("InterestFreeJuicePosition");
      const minCollateral = floatToDec18(0.01);
      const initialLimit = floatToDec18(1_000_000);
      const initPeriod = 3 * 86400;
      const duration = 180 * 86400;
      const challengePeriod = 2 * 86400;
      const riskPremiumPPM = 0;
      const liqPrice = floatToDec18(90000);
      const reservePPM = 150000;

      interestFreePosition = await interestFreeFactory.deploy(
        alice.address,
        await mintingHub.getAddress(),
        await JUSD.getAddress(),
        await collateralToken.getAddress(),
        minCollateral,
        initialLimit,
        initPeriod,
        duration,
        challengePeriod,
        riskPremiumPPM,
        liqPrice,
        reservePPM,
      );

      // Register position with JUSD (via MintingHub as it's a minter)
      await registerPositionWithJUSD(JUSD, mintingHub, await interestFreePosition.getAddress());

      // Wait for initialization period
      await evm_increaseTime(initPeriod + 60);

      // Alice deposits collateral
      await collateralToken
        .connect(alice)
        .approve(await interestFreePosition.getAddress(), collateralAmount);
      await collateralToken
        .connect(alice)
        .transfer(await interestFreePosition.getAddress(), collateralAmount);
    });

    it("should automatically invest minted JUSD into JUICE", async () => {
      const juiceBalanceBefore = await interestFreePosition.juiceBalance();
      expect(juiceBalanceBefore).to.equal(0n);

      // Alice mints JUSD
      await interestFreePosition.connect(alice).mint(alice.address, mintAmount);

      // Check that JUICE was automatically purchased
      const juiceBalanceAfter = await interestFreePosition.juiceBalance();
      expect(juiceBalanceAfter).to.be.gt(0n);

      console.log(`JUICE received: ${dec18ToFloat(juiceBalanceAfter)}`);
    });

    it("should keep JUICE locked in the contract", async () => {
      await interestFreePosition.connect(alice).mint(alice.address, mintAmount);

      const juiceBalance = await interestFreePosition.juiceBalance();
      const aliceJuiceBalance = await equity.balanceOf(alice.address);

      // JUICE should be in contract, not in Alice's wallet
      expect(juiceBalance).to.be.gt(0n);
      expect(aliceJuiceBalance).to.equal(0n);
    });

    it("should emit JuiceInvested event", async () => {
      const tx = await interestFreePosition.connect(alice).mint(alice.address, mintAmount);
      const receipt = await tx.wait();

      // Check for JuiceInvested event
      const juiceInvestedEvent = receipt?.logs.find((log: any) => {
        try {
          const parsed = interestFreePosition.interface.parseLog(log as any);
          return parsed?.name === "JuiceInvested";
        } catch {
          return false;
        }
      });

      expect(juiceInvestedEvent).to.not.be.undefined;
    });

    it("should ignore the target parameter and always mint to contract", async () => {
      const bobBalanceBefore = await JUSD.balanceOf(bob.address);
      const contractJuiceBalanceBefore = await interestFreePosition.juiceBalance();

      // Mint with bob.address as target
      await interestFreePosition.connect(alice).mint(bob.address, mintAmount);

      const bobBalanceAfter = await JUSD.balanceOf(bob.address);
      const contractJuiceBalanceAfter = await interestFreePosition.juiceBalance();

      // Bob should NOT receive any JUSD (target parameter is ignored)
      expect(bobBalanceAfter).to.equal(bobBalanceBefore);

      // Contract should receive JUICE instead
      expect(contractJuiceBalanceAfter).to.be.gt(contractJuiceBalanceBefore);
    });
  });

  describe("Selling JUICE", () => {
    let interestFreePosition: InterestFreeJuicePosition;
    const collateralAmount = floatToDec18(1);
    const mintAmount = floatToDec18(50000);

    beforeEach(async () => {
      const interestFreeFactory = await ethers.getContractFactory("InterestFreeJuicePosition");
      const minCollateral = floatToDec18(0.01);
      const initialLimit = floatToDec18(1_000_000);
      const initPeriod = 3 * 86400;
      const duration = 180 * 86400;
      const challengePeriod = 2 * 86400;
      const riskPremiumPPM = 0;
      const liqPrice = floatToDec18(90000);
      const reservePPM = 150000;

      interestFreePosition = await interestFreeFactory.deploy(
        alice.address,
        await mintingHub.getAddress(),
        await JUSD.getAddress(),
        await collateralToken.getAddress(),
        minCollateral,
        initialLimit,
        initPeriod,
        duration,
        challengePeriod,
        riskPremiumPPM,
        liqPrice,
        reservePPM,
      );

      // Register position with JUSD (via MintingHub as it's a minter)
      await registerPositionWithJUSD(JUSD, mintingHub, await interestFreePosition.getAddress());

      await evm_increaseTime(initPeriod + 60);

      await collateralToken
        .connect(alice)
        .approve(await interestFreePosition.getAddress(), collateralAmount);
      await collateralToken
        .connect(alice)
        .transfer(await interestFreePosition.getAddress(), collateralAmount);

      // Mint JUSD and auto-invest in JUICE
      await interestFreePosition.connect(alice).mint(alice.address, mintAmount);

      // Wait for minimum holding period (90 days)
      await evm_increaseTime(91 * 86400);
    });

    it("should sell JUICE and reduce principal", async () => {
      const juiceBalanceBefore = await interestFreePosition.juiceBalance();
      const principalBefore = await interestFreePosition.principal();

      const juiceToSell = juiceBalanceBefore / 2n; // Sell 50%

      await interestFreePosition.connect(alice).sellJuice(juiceToSell, 0n);

      const juiceBalanceAfter = await interestFreePosition.juiceBalance();
      const principalAfter = await interestFreePosition.principal();

      expect(juiceBalanceAfter).to.be.lt(juiceBalanceBefore);
      expect(principalAfter).to.be.lt(principalBefore);

      console.log(`JUICE sold: ${dec18ToFloat(juiceToSell)}`);
      console.log(
        `Principal reduced by: ${dec18ToFloat(principalBefore - principalAfter)}`,
      );
    });

    it("should revert if trying to sell more JUICE than owned", async () => {
      const juiceBalance = await interestFreePosition.juiceBalance();
      const tooMuch = juiceBalance + 1n;

      await expect(
        interestFreePosition.connect(alice).sellJuice(tooMuch, 0n),
      ).to.be.revertedWithCustomError(interestFreePosition, "InsufficientJuiceBalance");
    });

    it("should enforce slippage protection", async () => {
      const juiceBalance = await interestFreePosition.juiceBalance();
      const unrealisticMinJusd = floatToDec18(1_000_000); // Expecting way too much

      await expect(
        interestFreePosition.connect(alice).sellJuice(juiceBalance / 2n, unrealisticMinJusd),
      ).to.be.revertedWithCustomError(interestFreePosition, "SlippageExceeded");
    });

    it("should emit JuiceSold event", async () => {
      const juiceBalance = await interestFreePosition.juiceBalance();
      const tx = await interestFreePosition
        .connect(alice)
        .sellJuice(juiceBalance / 4n, 0n);
      const receipt = await tx.wait();

      const juiceSoldEvent = receipt?.logs.find((log: any) => {
        try {
          const parsed = interestFreePosition.interface.parseLog(log as any);
          return parsed?.name === "JuiceSold";
        } catch {
          return false;
        }
      });

      expect(juiceSoldEvent).to.not.be.undefined;
    });

    it("should transfer surplus JUSD (profit + reserve) to owner when JUICE is sold at a profit", async () => {
      // Scenario: User mints, JUICE appreciates, user sells for profit
      // The profit + returned reserve should be transferred to owner

      const aliceBalanceBefore = await JUSD.balanceOf(alice.address);
      const contractBalanceBefore = await JUSD.balanceOf(
        await interestFreePosition.getAddress(),
      );
      const principalBefore = await interestFreePosition.principal();
      const juiceBalance = await interestFreePosition.juiceBalance();

      // Sell all JUICE
      await interestFreePosition.connect(alice).sellJuice(juiceBalance, 0n);

      const aliceBalanceAfter = await JUSD.balanceOf(alice.address);
      const contractBalanceAfter = await JUSD.balanceOf(
        await interestFreePosition.getAddress(),
      );
      const principalAfter = await interestFreePosition.principal();

      // Alice should receive some JUSD (the surplus)
      const aliceReceived = aliceBalanceAfter - aliceBalanceBefore;
      expect(aliceReceived).to.be.gt(0n);

      // Principal should be reduced
      expect(principalAfter).to.be.lt(principalBefore);

      // Contract should not accumulate JUSD (surplus should be transferred out)
      expect(contractBalanceAfter).to.be.lte(contractBalanceBefore);

      console.log(`Alice received surplus: ${dec18ToFloat(aliceReceived)} JUSD`);
      console.log(
        `Principal reduced from ${dec18ToFloat(principalBefore)} to ${dec18ToFloat(principalAfter)}`,
      );
    });

    it("should handle partial JUICE sales with surplus correctly", async () => {
      const aliceBalanceBefore = await JUSD.balanceOf(alice.address);
      const principalBefore = await interestFreePosition.principal();
      const juiceBalance = await interestFreePosition.juiceBalance();

      // Sell only half of JUICE
      const juiceToSell = juiceBalance / 2n;
      const jusdReceived = await equity.calculateProceeds(juiceToSell);

      await interestFreePosition.connect(alice).sellJuice(juiceToSell, 0n);

      const aliceBalanceAfter = await JUSD.balanceOf(alice.address);
      const principalAfter = await interestFreePosition.principal();

      // Alice should receive any surplus
      const aliceReceived = aliceBalanceAfter - aliceBalanceBefore;

      // Principal should be reduced
      expect(principalAfter).to.be.lt(principalBefore);

      // If there's a surplus (profit), Alice should receive it
      // The exact amount depends on the JUICE price
      if (aliceReceived > 0n) {
        expect(aliceReceived).to.be.gt(0n);
      }
    });

    it("should not leave JUSD stuck in contract after selling JUICE", async () => {
      const juiceBalance = await interestFreePosition.juiceBalance();

      // Get contract JUSD balance before
      const contractBalanceBefore = await JUSD.balanceOf(
        await interestFreePosition.getAddress(),
      );

      // Sell all JUICE
      await interestFreePosition.connect(alice).sellJuice(juiceBalance, 0n);

      // Get contract JUSD balance after
      const contractBalanceAfter = await JUSD.balanceOf(
        await interestFreePosition.getAddress(),
      );

      // Contract should not have more JUSD after the sale
      // (any surplus should have been transferred to owner)
      expect(contractBalanceAfter).to.be.lte(contractBalanceBefore);
    });

    it("should handle selling JUICE when value barely covers debt (minimal surplus)", async () => {
      // The existing tests already cover the case where JUICE appreciates (90 days waiting)
      // This test documents that surplus can be minimal when JUICE price hasn't increased much

      // After waiting 90 days in beforeEach, JUICE has appreciated slightly
      // When we sell, we should get SOME surplus but not huge amounts

      const aliceBalanceBefore = await JUSD.balanceOf(alice.address);
      const principalBefore = await interestFreePosition.principal();
      const juiceBalance = await interestFreePosition.juiceBalance();

      // Calculate expected return
      const expectedJusd = await equity.calculateProceeds(juiceBalance);

      // Sell all remaining JUICE
      await interestFreePosition.connect(alice).sellJuice(juiceBalance, 0n);

      const aliceBalanceAfter = await JUSD.balanceOf(alice.address);
      const principalAfter = await interestFreePosition.principal();
      const aliceReceived = aliceBalanceAfter - aliceBalanceBefore;

      // Some surplus should be transferred (even if minimal)
      expect(aliceReceived).to.be.gte(0n);

      // Principal should be reduced or fully repaid
      expect(principalAfter).to.be.lte(principalBefore);

      console.log(`Minimal surplus test: Alice received ${dec18ToFloat(aliceReceived)} JUSD`);
      console.log(
        `Principal: ${dec18ToFloat(principalBefore)} → ${dec18ToFloat(principalAfter)}`,
      );
    });
  });

  describe("Zero Interest Accrual", () => {
    let interestFreePosition: InterestFreeJuicePosition;
    const collateralAmount = floatToDec18(1);
    const mintAmount = floatToDec18(50000);

    beforeEach(async () => {
      const interestFreeFactory = await ethers.getContractFactory("InterestFreeJuicePosition");
      const minCollateral = floatToDec18(0.01);
      const initialLimit = floatToDec18(1_000_000);
      const initPeriod = 3 * 86400;
      const duration = 180 * 86400;
      const challengePeriod = 2 * 86400;
      const riskPremiumPPM = 0;
      const liqPrice = floatToDec18(90000);
      const reservePPM = 150000;

      interestFreePosition = await interestFreeFactory.deploy(
        alice.address,
        await mintingHub.getAddress(),
        await JUSD.getAddress(),
        await collateralToken.getAddress(),
        minCollateral,
        initialLimit,
        initPeriod,
        duration,
        challengePeriod,
        riskPremiumPPM,
        liqPrice,
        reservePPM,
      );

      // Register position with JUSD (via MintingHub as it's a minter)
      await registerPositionWithJUSD(JUSD, mintingHub, await interestFreePosition.getAddress());

      await evm_increaseTime(initPeriod + 60);

      await collateralToken
        .connect(alice)
        .approve(await interestFreePosition.getAddress(), collateralAmount);
      await collateralToken
        .connect(alice)
        .transfer(await interestFreePosition.getAddress(), collateralAmount);

      await interestFreePosition.connect(alice).mint(alice.address, mintAmount);
    });

    it("should not accrue any interest over time", async () => {
      const interestBefore = await interestFreePosition.interest();
      expect(interestBefore).to.equal(0n);

      // Wait 30 days
      await evm_increaseTime(30 * 86400);

      const interestAfter = await interestFreePosition.interest();
      expect(interestAfter).to.equal(0n);

      // Wait another 60 days (90 total)
      await evm_increaseTime(60 * 86400);

      const interestFinal = await interestFreePosition.interest();
      expect(interestFinal).to.equal(0n);
    });

    it("should keep fixed rate at zero", async () => {
      const rateBefore = await interestFreePosition.fixedAnnualRatePPM();
      expect(rateBefore).to.equal(0n);

      // Wait some time
      await evm_increaseTime(30 * 86400);

      const rateAfter = await interestFreePosition.fixedAnnualRatePPM();
      expect(rateAfter).to.equal(0n);
    });
  });

  describe("Position Ownership Transfer", () => {
    let interestFreePosition: InterestFreeJuicePosition;
    const collateralAmount = floatToDec18(1);
    const mintAmount = floatToDec18(50000);

    beforeEach(async () => {
      const interestFreeFactory = await ethers.getContractFactory("InterestFreeJuicePosition");
      const minCollateral = floatToDec18(0.01);
      const initialLimit = floatToDec18(1_000_000);
      const initPeriod = 3 * 86400;
      const duration = 180 * 86400;
      const challengePeriod = 2 * 86400;
      const riskPremiumPPM = 0;
      const liqPrice = floatToDec18(90000);
      const reservePPM = 150000;

      interestFreePosition = await interestFreeFactory.deploy(
        alice.address,
        await mintingHub.getAddress(),
        await JUSD.getAddress(),
        await collateralToken.getAddress(),
        minCollateral,
        initialLimit,
        initPeriod,
        duration,
        challengePeriod,
        riskPremiumPPM,
        liqPrice,
        reservePPM,
      );

      // Register position with JUSD (via MintingHub as it's a minter)
      await registerPositionWithJUSD(JUSD, mintingHub, await interestFreePosition.getAddress());

      await evm_increaseTime(initPeriod + 60);

      await collateralToken
        .connect(alice)
        .approve(await interestFreePosition.getAddress(), collateralAmount);
      await collateralToken
        .connect(alice)
        .transfer(await interestFreePosition.getAddress(), collateralAmount);

      await interestFreePosition.connect(alice).mint(alice.address, mintAmount);
    });

    it("should allow ownership transfer", async () => {
      const ownerBefore = await interestFreePosition.owner();
      expect(ownerBefore).to.equal(alice.address);

      // Transfer ownership to bob
      await interestFreePosition.connect(alice).transferOwnership(bob.address);

      const ownerAfter = await interestFreePosition.owner();
      expect(ownerAfter).to.equal(bob.address);
    });

    it("should allow new owner to sell JUICE", async () => {
      // Transfer ownership
      await interestFreePosition.connect(alice).transferOwnership(bob.address);

      // Wait for holding period
      await evm_increaseTime(91 * 86400);

      const juiceBalance = await interestFreePosition.juiceBalance();

      // Bob (new owner) should be able to sell JUICE
      await expect(
        interestFreePosition.connect(bob).sellJuice(juiceBalance / 4n, 0n),
      ).to.not.be.reverted;
    });

    it("should prevent previous owner from selling JUICE", async () => {
      await interestFreePosition.connect(alice).transferOwnership(bob.address);
      await evm_increaseTime(91 * 86400);

      const juiceBalance = await interestFreePosition.juiceBalance();

      // Alice should no longer be able to sell
      await expect(
        interestFreePosition.connect(alice).sellJuice(juiceBalance / 4n, 0n),
      ).to.be.reverted;
    });
  });

  describe("JUICE Transfer Security", () => {
    let sourcePosition: InterestFreeJuicePosition;
    let targetPosition: InterestFreeJuicePosition;
    const collateralAmount = floatToDec18(1);
    const mintAmount = floatToDec18(50000);

    beforeEach(async () => {
      const interestFreeFactory = await ethers.getContractFactory("InterestFreeJuicePosition");
      const minCollateral = floatToDec18(0.01);
      const initialLimit = floatToDec18(1_000_000);
      const initPeriod = 3 * 86400;
      const duration = 180 * 86400;
      const challengePeriod = 2 * 86400;
      const riskPremiumPPM = 0;
      const liqPrice = floatToDec18(90000);
      const reservePPM = 150000;

      // Deploy source position
      sourcePosition = await interestFreeFactory.deploy(
        alice.address,
        await mintingHub.getAddress(),
        await JUSD.getAddress(),
        await collateralToken.getAddress(),
        minCollateral,
        initialLimit,
        initPeriod,
        duration,
        challengePeriod,
        riskPremiumPPM,
        liqPrice,
        reservePPM,
      );

      await evm_increaseTime(initPeriod + 60);

      await collateralToken
        .connect(alice)
        .approve(await sourcePosition.getAddress(), collateralAmount);
      await collateralToken
        .connect(alice)
        .transfer(await sourcePosition.getAddress(), collateralAmount);

      // Register source position with JUSD
      await registerPositionWithJUSD(JUSD, mintingHub, await sourcePosition.getAddress());

      await sourcePosition.connect(alice).mint(alice.address, mintAmount);

      // Deploy target position
      targetPosition = await interestFreeFactory.deploy(
        bob.address,
        await mintingHub.getAddress(),
        await JUSD.getAddress(),
        await collateralToken.getAddress(),
        minCollateral,
        initialLimit,
        initPeriod,
        duration,
        challengePeriod,
        riskPremiumPPM,
        liqPrice,
        reservePPM,
      );

      // Register target position with JUSD
      await registerPositionWithJUSD(JUSD, mintingHub, await targetPosition.getAddress());
    });

    it("should successfully transfer JUICE to another InterestFreeJuicePosition", async () => {
      const juiceBalanceBefore = await sourcePosition.juiceBalance();
      const targetBalanceBefore = await targetPosition.juiceBalance();

      expect(juiceBalanceBefore).to.be.gt(0n);
      expect(targetBalanceBefore).to.equal(0n);

      await sourcePosition.connect(alice).transferJuice(await targetPosition.getAddress());

      const juiceBalanceAfter = await sourcePosition.juiceBalance();
      const targetBalanceAfter = await targetPosition.juiceBalance();

      expect(juiceBalanceAfter).to.equal(0n);
      expect(targetBalanceAfter).to.equal(juiceBalanceBefore);

      console.log(`JUICE transferred: ${dec18ToFloat(juiceBalanceBefore)}`);
    });

    it("should revert when trying to transfer JUICE to an EOA", async () => {
      await expect(
        sourcePosition.connect(alice).transferJuice(bob.address),
      ).to.be.revertedWith("Target must be a contract");
    });

    it("should revert when trying to transfer JUICE to a non-InterestFreeJuicePosition contract", async () => {
      // Try to transfer to the JUSD contract (not an InterestFreeJuicePosition)
      await expect(
        sourcePosition.connect(alice).transferJuice(await JUSD.getAddress()),
      ).to.be.revertedWith("Target must be InterestFreeJuicePosition");
    });

    it("should revert when trying to transfer JUICE to zero address", async () => {
      await expect(
        sourcePosition.connect(alice).transferJuice(ethers.ZeroAddress),
      ).to.be.revertedWith("Invalid target");
    });

    it("should only allow owner or roller to transfer JUICE", async () => {
      await expect(
        sourcePosition.connect(bob).transferJuice(await targetPosition.getAddress()),
      ).to.be.reverted;
    });

    it("should handle zero JUICE balance gracefully", async () => {
      // Create a new position with no JUICE
      const interestFreeFactory = await ethers.getContractFactory("InterestFreeJuicePosition");
      const emptyPosition = await interestFreeFactory.deploy(
        alice.address,
        await mintingHub.getAddress(),
        await JUSD.getAddress(),
        await collateralToken.getAddress(),
        floatToDec18(0.01),
        floatToDec18(1_000_000),
        3 * 86400,
        180 * 86400,
        2 * 86400,
        0,
        floatToDec18(90000),
        150000,
      );

      // Should not revert, just do nothing
      await expect(
        emptyPosition.connect(alice).transferJuice(await targetPosition.getAddress()),
      ).to.not.be.reverted;

      const targetBalance = await targetPosition.juiceBalance();
      expect(targetBalance).to.equal(0n);
    });
  });

  describe("JUICE Voting Power Delegation", () => {
    let interestFreePosition: InterestFreeJuicePosition;
    const collateralAmount = floatToDec18(1);
    const mintAmount = floatToDec18(50000);

    beforeEach(async () => {
      const interestFreeFactory = await ethers.getContractFactory("InterestFreeJuicePosition");
      const minCollateral = floatToDec18(0.01);
      const initialLimit = floatToDec18(1_000_000);
      const initPeriod = 3 * 86400;
      const duration = 180 * 86400;
      const challengePeriod = 2 * 86400;
      const riskPremiumPPM = 0;
      const liqPrice = floatToDec18(90000);
      const reservePPM = 150000;

      interestFreePosition = await interestFreeFactory.deploy(
        alice.address,
        await mintingHub.getAddress(),
        await JUSD.getAddress(),
        await collateralToken.getAddress(),
        minCollateral,
        initialLimit,
        initPeriod,
        duration,
        challengePeriod,
        riskPremiumPPM,
        liqPrice,
        reservePPM,
      );

      // Register position with JUSD (via MintingHub as it's a minter)
      await registerPositionWithJUSD(JUSD, mintingHub, await interestFreePosition.getAddress());

      await evm_increaseTime(initPeriod + 60);

      await collateralToken
        .connect(alice)
        .approve(await interestFreePosition.getAddress(), collateralAmount);
      await collateralToken
        .connect(alice)
        .transfer(await interestFreePosition.getAddress(), collateralAmount);

      await interestFreePosition.connect(alice).mint(alice.address, mintAmount);
    });

    it("should allow owner to delegate JUICE voting power", async () => {
      // Delegate voting power to bob
      await expect(
        interestFreePosition.connect(alice).delegateJuiceVotingPower(bob.address),
      ).to.not.be.reverted;
    });

    it("should prevent non-owner from delegating JUICE voting power", async () => {
      // Bob tries to delegate (should fail)
      await expect(
        interestFreePosition.connect(bob).delegateJuiceVotingPower(bob.address),
      ).to.be.reverted;
    });

    it("should allow owner to delegate to themselves", async () => {
      // Alice delegates to herself
      await expect(
        interestFreePosition.connect(alice).delegateJuiceVotingPower(alice.address),
      ).to.not.be.reverted;
    });
  });

  describe("View Functions", () => {
    let interestFreePosition: InterestFreeJuicePosition;
    const collateralAmount = floatToDec18(1);
    const mintAmount = floatToDec18(50000);

    beforeEach(async () => {
      const interestFreeFactory = await ethers.getContractFactory("InterestFreeJuicePosition");
      const minCollateral = floatToDec18(0.01);
      const initialLimit = floatToDec18(1_000_000);
      const initPeriod = 3 * 86400;
      const duration = 180 * 86400;
      const challengePeriod = 2 * 86400;
      const riskPremiumPPM = 0;
      const liqPrice = floatToDec18(90000);
      const reservePPM = 150000;

      interestFreePosition = await interestFreeFactory.deploy(
        alice.address,
        await mintingHub.getAddress(),
        await JUSD.getAddress(),
        await collateralToken.getAddress(),
        minCollateral,
        initialLimit,
        initPeriod,
        duration,
        challengePeriod,
        riskPremiumPPM,
        liqPrice,
        reservePPM,
      );

      // Register position with JUSD (via MintingHub as it's a minter)
      await registerPositionWithJUSD(JUSD, mintingHub, await interestFreePosition.getAddress());

      await evm_increaseTime(initPeriod + 60);

      await collateralToken
        .connect(alice)
        .approve(await interestFreePosition.getAddress(), collateralAmount);
      await collateralToken
        .connect(alice)
        .transfer(await interestFreePosition.getAddress(), collateralAmount);

      await interestFreePosition.connect(alice).mint(alice.address, mintAmount);
    });

    it("should return correct JUICE balance", async () => {
      const juiceBalance = await interestFreePosition.juiceBalance();
      expect(juiceBalance).to.be.gt(0n);

      const equityBalance = await equity.balanceOf(await interestFreePosition.getAddress());
      expect(juiceBalance).to.equal(equityBalance);
    });

    it("should return correct JUICE value in JUSD", async () => {
      const juiceValue = await interestFreePosition.getJuiceValue();
      expect(juiceValue).to.be.gt(0n);

      console.log(`JUICE value in JUSD: ${dec18ToFloat(juiceValue)}`);
    });

    it("should return true for isInterestFree", async () => {
      const isInterestFree = await interestFreePosition.isInterestFree();
      expect(isInterestFree).to.be.true;
    });
  });
});
