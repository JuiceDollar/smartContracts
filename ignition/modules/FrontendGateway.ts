import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import JuiceDollarModule from "./JuiceDollar";
import DEPSWrapperModule from "./DEPSWrapper";

export default buildModule("FrontendGateway", (m) => {
  const { juiceDollar } = m.useModule(JuiceDollarModule);
  const { depsWrapper } = m.useModule(DEPSWrapperModule);

  const frontendGateway = m.contract("FrontendGateway", [juiceDollar, depsWrapper]);
  
  return { frontendGateway };
});