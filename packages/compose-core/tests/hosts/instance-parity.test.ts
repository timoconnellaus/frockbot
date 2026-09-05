import { describe } from "bun:test";
import {
  pluginArm,
  runInstanceContract,
  sourceArm,
} from "../helpers/instance-contract";

/**
 * A hosted plugin is an ordinary instance. The control arm is the point: it
 * keeps the shared contract honest, so a hosted-plugin failure cannot be hidden
 * by weakening an assertion.
 */
describe("a plugin supplied as source behaves as an ordinary instance", () => {
  runInstanceContract(pluginArm);
  runInstanceContract(sourceArm());
});
