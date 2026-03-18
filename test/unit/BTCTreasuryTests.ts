import { expect } from "chai";
import { DECIMALS } from "../../scripts/utils/math";
import { ethers } from "hardhat";
import { evm_increaseTime } from "../utils";
import {
  Equity,
  JuiceDollar,
  StablecoinBridge,
  TestToken,
  Savings,
  BTCTreasury,
  TestWcBTC,
} from "../../typechain";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("BTCTreasury Tests", () => {
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;

  let JUSD: JuiceDollar;
  let equity: Equity;
  let savings: Savings;
  let mockXUSD: TestToken;
  let bridge: StablecoinBridge;
  let treasury: BTCTreasury;
  let wcbtc: TestWcBTC;

  const BRIDGE_LIMIT = 10_000_000n * DECIMALS;
  const BRIDGE_WEEKS = 52;
  const MINT_CEILING = 35_000n * DECIMALS; // 35,000 JUSD per cBTC (~50% LTV at $70k)
  const RISK_PREMIUM = 50_000; // 5% risk premium
  const RESERVE_PPM = 200_000; // 20% reserve
  const APP_PERIOD = 10 * 86400; // 10 days

  before(async () => {
    [owner, alice, bob] = await ethers.getSigners();

    // Deploy core contracts
    const JuiceDollarFactory = await ethers.getContractFactory("JuiceDollar");
    JUSD = await JuiceDollarFactory.deploy(APP_PERIOD);

    const equityAddr = await JUSD.reserve();
    equity = await ethers.getContractAt("Equity", equityAddr);

    // Deploy WcBTC
    const WcBTCFactory = await ethers.getContractFactory("TestWcBTC");
    wcbtc = await WcBTCFactory.deploy();

    // Deploy Savings (acts as leadrate source)
    const SavingsFactory = await ethers.getContractFactory("Savings");
    savings = await SavingsFactory.deploy(await JUSD.getAddress(), 50_000n); // 5% leadrate

    // Deploy mock stablecoin for bootstrapping JUSD
    const XUSDFactory = await ethers.getContractFactory("TestToken");
    mockXUSD = await XUSDFactory.deploy("MockUSD", "XUSD", 18);

    // Deploy bridge to bootstrap JUSD supply
    const bridgeFactory = await ethers.getContractFactory("StablecoinBridge");
    bridge = await bridgeFactory.deploy(
      await mockXUSD.getAddress(),
      await JUSD.getAddress(),
      BRIDGE_LIMIT,
      BRIDGE_WEEKS,
    );

    // Register bridge as minter (initialize for first minter)
    await JUSD.initialize(await bridge.getAddress(), "Bootstrap bridge");

    // Mint JUSD via bridge for testing
    await mockXUSD.approve(await bridge.getAddress(), BRIDGE_LIMIT);
    await bridge.mint(1_000_000n * DECIMALS);

    // Seed equity pool (required for governance and savings)
    await JUSD.approve(equityAddr, 100_000n * DECIMALS);
    await equity.invest(100_000n * DECIMALS, 0);

    // Deploy BTCTreasury
    const TreasuryFactory = await ethers.getContractFactory("BTCTreasury");
    treasury = await TreasuryFactory.deploy(
      await JUSD.getAddress(),
      await wcbtc.getAddress(),
      await savings.getAddress(), // leadrate source
      await wcbtc.getAddress(), // WCBTC address
      RISK_PREMIUM,
      RESERVE_PPM,
      MINT_CEILING,
    );

    // Register treasury as minter (need allowance for the application fee)
    const treasuryAddr = await treasury.getAddress();
    const jusdAddr = await JUSD.getAddress();
    await JUSD.approve(jusdAddr, 1000n * DECIMALS);
    await JUSD.suggestMinter(treasuryAddr, APP_PERIOD, 1000n * DECIMALS, "BTCTreasury module");

    // Wait for application period
    await evm_increaseTime(APP_PERIOD + 1);

    // Verify it's now a valid minter
    expect(await JUSD.isMinter(treasuryAddr)).to.be.true;

    // Give alice and bob some WcBTC (by sending native)
    await wcbtc.connect(alice).deposit({ value: ethers.parseEther("10") });
    await wcbtc.connect(bob).deposit({ value: ethers.parseEther("5") });

    // Give alice some JUSD for repayment later
    await JUSD.transfer(await alice.getAddress(), 200_000n * DECIMALS);
    await JUSD.transfer(await bob.getAddress(), 100_000n * DECIMALS);
  });

  describe("deployment", () => {
    it("should have correct parameters", async () => {
      expect(await treasury.mintCeiling()).to.equal(MINT_CEILING);
      expect(await treasury.riskPremiumPPM()).to.equal(RISK_PREMIUM);
      expect(await treasury.reservePPM()).to.equal(RESERVE_PPM);
      expect(await treasury.stopped()).to.be.false;
      expect(await treasury.totalMinted()).to.equal(0);
    });
  });

  describe("deposit and mint", () => {
    it("should deposit cBTC via ERC20 transfer", async () => {
      const amount = ethers.parseEther("2"); // 2 cBTC
      await wcbtc.connect(alice).approve(await treasury.getAddress(), amount);
      await treasury.connect(alice).deposit(amount);

      const account = await treasury.accounts(await alice.getAddress());
      expect(account.collateral).to.equal(amount);
      expect(account.principal).to.equal(0);
    });

    it("should deposit native cBTC", async () => {
      const amount = ethers.parseEther("1");
      await treasury.connect(bob).deposit(0, { value: amount });

      const account = await treasury.accounts(await bob.getAddress());
      expect(account.collateral).to.equal(amount);
    });

    it("should revert on zero deposit", async () => {
      await expect(treasury.connect(alice).deposit(0)).to.be.revertedWithCustomError(
        treasury,
        "ZeroAmount",
      );
    });

    it("should mint JUSD against collateral", async () => {
      // Alice has 2 cBTC, ceiling is 35,000 JUSD/cBTC → max 70,000 JUSD
      const mintAmount = 50_000n * DECIMALS;

      const aliceBalBefore = await JUSD.balanceOf(await alice.getAddress());
      await treasury.connect(alice).mint(mintAmount);
      const aliceBalAfter = await JUSD.balanceOf(await alice.getAddress());

      // User receives 80% (reserve is 20%)
      const expectedReceived = (mintAmount * 800_000n) / 1_000_000n;
      expect(aliceBalAfter - aliceBalBefore).to.equal(expectedReceived);

      const account = await treasury.accounts(await alice.getAddress());
      expect(account.principal).to.equal(mintAmount);
      expect(await treasury.totalMinted()).to.equal(mintAmount);
    });

    it("should revert when exceeding ceiling", async () => {
      // Alice has 2 cBTC, ceiling 35,000/cBTC → max 70,000. Already minted 50,000
      const tooMuch = 21_000n * DECIMALS;
      await expect(treasury.connect(alice).mint(tooMuch)).to.be.revertedWithCustomError(
        treasury,
        "ExceedsCeiling",
      );
    });

    it("should revert on zero mint", async () => {
      await expect(treasury.connect(alice).mint(0)).to.be.revertedWithCustomError(
        treasury,
        "ZeroAmount",
      );
    });

    it("should depositAndMint in one transaction", async () => {
      const cbtcAmount = ethers.parseEther("1"); // 1 cBTC native
      const jusdAmount = 20_000n * DECIMALS;

      const bobBalBefore = await JUSD.balanceOf(await bob.getAddress());
      await treasury.connect(bob).depositAndMint(0, jusdAmount, { value: cbtcAmount });
      const bobBalAfter = await JUSD.balanceOf(await bob.getAddress());

      const expectedReceived = (jusdAmount * 800_000n) / 1_000_000n;
      expect(bobBalAfter - bobBalBefore).to.equal(expectedReceived);

      const account = await treasury.accounts(await bob.getAddress());
      expect(account.collateral).to.equal(ethers.parseEther("2")); // 1 + 1
      expect(account.principal).to.equal(jusdAmount);
    });

    it("should depositAndMint with jusdAmount=0 (deposit only)", async () => {
      const cbtcAmount = ethers.parseEther("0.5");
      await wcbtc.connect(alice).approve(await treasury.getAddress(), cbtcAmount);

      const accountBefore = await treasury.accounts(await alice.getAddress());
      await treasury.connect(alice).depositAndMint(cbtcAmount, 0);
      const accountAfter = await treasury.accounts(await alice.getAddress());

      expect(accountAfter.collateral).to.equal(accountBefore.collateral + cbtcAmount);
      expect(accountAfter.principal).to.equal(accountBefore.principal); // unchanged
    });
  });

  describe("interest accrual", () => {
    it("should accrue interest over time", async () => {
      // Fast forward 365 days
      await evm_increaseTime(365 * 86400);

      const [principal, interest] = await treasury.getDebt(await alice.getAddress());

      // Rate = 5% leadrate + 5% premium = 10%
      // Usable principal = 50000 * 80% = 40000
      // Interest = 40000 * 10% = ~4000 JUSD per year
      expect(principal).to.equal(50_000n * DECIMALS);
      expect(interest).to.be.gt(3_900n * DECIMALS);
      expect(interest).to.be.lt(4_100n * DECIMALS);
    });
  });

  describe("repay and withdraw", () => {
    it("should repay interest first, then principal", async () => {
      const [principalBefore, interestBefore] = await treasury.getDebt(await alice.getAddress());

      // Repay more than the interest to also reduce principal
      const repayAmount = interestBefore + 5_000n * DECIMALS;
      await JUSD.connect(alice).approve(await treasury.getAddress(), repayAmount);
      await treasury.connect(alice).repay(repayAmount);

      const [principalAfter,] = await treasury.getDebt(await alice.getAddress());
      // Principal should have decreased since we paid more than just interest
      expect(principalAfter).to.be.lt(principalBefore);
    });

    it("should revert when repaying more than debt", async () => {
      const [principal, interest] = await treasury.getDebt(await alice.getAddress());
      const tooMuch = principal + interest + 10_000n * DECIMALS;

      await JUSD.connect(alice).approve(await treasury.getAddress(), tooMuch);
      await expect(treasury.connect(alice).repay(tooMuch)).to.be.revertedWithCustomError(
        treasury,
        "ExceedsDebt",
      );
    });

    it("should withdraw collateral when sufficiently covered", async () => {
      // First check how much can be withdrawn
      const available = await treasury.availableToWithdraw(await alice.getAddress());
      expect(available).to.be.gt(0);

      const aliceAccount = await treasury.accounts(await alice.getAddress());
      const collBefore = aliceAccount.collateral;

      // Withdraw a small amount
      const withdrawAmount = ethers.parseEther("0.1");
      await treasury.connect(alice).withdraw(withdrawAmount, false);

      const aliceAccountAfter = await treasury.accounts(await alice.getAddress());
      expect(aliceAccountAfter.collateral).to.equal(collBefore - withdrawAmount);
    });

    it("should revert withdraw if undercollateralized", async () => {
      // Try to withdraw everything — should fail because there's still principal
      const aliceAccount = await treasury.accounts(await alice.getAddress());
      await expect(
        treasury.connect(alice).withdraw(aliceAccount.collateral, false),
      ).to.be.revertedWithCustomError(treasury, "InsufficientCollateral");
    });

    it("should repayAllAndWithdraw", async () => {
      const [principal, interest] = await treasury.getDebt(await bob.getAddress());
      const total = principal + interest + 1000n * DECIMALS; // buffer for in-block accrual

      await JUSD.connect(bob).approve(await treasury.getAddress(), total);
      await treasury.connect(bob).repayAllAndWithdraw(false);

      const account = await treasury.accounts(await bob.getAddress());
      expect(account.principal).to.equal(0);
      expect(account.collateral).to.equal(0);
      expect(account.interest).to.equal(0);
    });
  });

  describe("no liquidation", () => {
    it("positions stay open regardless of collateral value", async () => {
      // The entire point: even if BTC drops 80%, the position stays open
      const account = await treasury.accounts(await alice.getAddress());
      expect(account.collateral).to.be.gt(0);
      expect(account.principal).to.be.gt(0);

      // No challenge(), no liquidate(), no forceSale() — position simply persists
    });
  });

  describe("governance", () => {
    it("qualified holder can propose mint ceiling change", async () => {
      const newCeiling = 40_000n * DECIMALS;
      await treasury.connect(owner).proposeMintCeiling(newCeiling, []);
      expect(await treasury.nextMintCeiling()).to.equal(newCeiling);
    });

    it("cannot apply ceiling change before timelock", async () => {
      await expect(treasury.applyCeilingChange()).to.be.revertedWithCustomError(
        treasury,
        "ChangeNotReady",
      );
    });

    it("can apply ceiling change after timelock", async () => {
      await evm_increaseTime(7 * 86400 + 1);
      await treasury.applyCeilingChange();
      expect(await treasury.mintCeiling()).to.equal(40_000n * DECIMALS);
    });

    it("ceiling=0 blocks new mints but allows repay", async () => {
      // Propose ceiling = 0
      await treasury.connect(owner).proposeMintCeiling(0, []);
      await evm_increaseTime(7 * 86400 + 1);
      await treasury.applyCeilingChange();
      expect(await treasury.mintCeiling()).to.equal(0);

      // Minting should fail
      await expect(treasury.connect(alice).mint(1000n * DECIMALS)).to.be.revertedWithCustomError(
        treasury,
        "ExceedsCeiling",
      );

      // availableToMint should return 0
      expect(await treasury.availableToMint(await alice.getAddress())).to.equal(0);

      // Restore ceiling for remaining tests
      await treasury.connect(owner).proposeMintCeiling(40_000n * DECIMALS, []);
      await evm_increaseTime(7 * 86400 + 1);
      await treasury.applyCeilingChange();
    });
  });

  describe("emergency stop", () => {
    it("non-qualified cannot emergency stop", async () => {
      await expect(
        treasury.connect(bob).emergencyStop([], "panic"),
      ).to.be.revertedWithCustomError(treasury, "NotQualified");
    });

    it("deposits blocked when stopped", async () => {
      // Deploy a fresh treasury to test stop independently
      const TreasuryFactory = await ethers.getContractFactory("BTCTreasury");
      const freshTreasury = await TreasuryFactory.deploy(
        await JUSD.getAddress(),
        await wcbtc.getAddress(),
        await savings.getAddress(),
        await wcbtc.getAddress(),
        RISK_PREMIUM,
        RESERVE_PPM,
        MINT_CEILING,
      );

      // Register as minter
      const addr = await freshTreasury.getAddress();
      const jusdAddr = await JUSD.getAddress();
      await JUSD.approve(jusdAddr, 1000n * DECIMALS);
      await JUSD.suggestMinter(addr, APP_PERIOD, 1000n * DECIMALS, "Fresh treasury");
      await evm_increaseTime(APP_PERIOD + 1);

      // Simulate stop (directly via contract, needs 10% quorum — owner has it)
      // Owner invested 100k JUSD into equity at the start, should have >10% votes
      await freshTreasury.connect(owner).emergencyStop([], "test stop");
      expect(await freshTreasury.stopped()).to.be.true;

      // Deposit should fail
      await expect(
        freshTreasury.connect(alice).deposit(0, { value: ethers.parseEther("1") }),
      ).to.be.revertedWithCustomError(freshTreasury, "Stopped");
    });
  });

  describe("view functions", () => {
    it("availableToMint returns correct value", async () => {
      const account = await treasury.accounts(await alice.getAddress());
      const ceiling = await treasury.mintCeiling();
      const maxMintable = (account.collateral * ceiling) / DECIMALS;
      const available = await treasury.availableToMint(await alice.getAddress());
      expect(available).to.equal(maxMintable - account.principal);
    });

    it("availableToWithdraw returns 0 for fully utilized position", async () => {
      // Mint up to the ceiling
      const available = await treasury.availableToMint(await alice.getAddress());
      if (available > 0n) {
        await treasury.connect(alice).mint(available);
      }

      // Now availableToWithdraw should be 0 (fully utilized)
      const withdrawable = await treasury.availableToWithdraw(await alice.getAddress());
      expect(withdrawable).to.equal(0);
    });

    it("getDebt returns correct values", async () => {
      const [principal, interest] = await treasury.getDebt(await alice.getAddress());
      expect(principal).to.be.gt(0);
      expect(interest).to.be.gte(0);
    });
  });
});
