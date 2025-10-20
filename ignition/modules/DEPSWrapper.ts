import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import JuiceDollarModule from "./JuiceDollar";

export default buildModule("DEPSWrapper", (m) => {
  const { juiceDollar } = m.useModule(JuiceDollarModule);
  const equityAddress = m.staticCall(juiceDollar, "reserve", []);

  const depsWrapper = m.contract("DEPSWrapper", [equityAddress]);
  
  return { depsWrapper };
});