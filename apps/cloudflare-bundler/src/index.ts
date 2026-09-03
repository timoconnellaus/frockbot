/**
 * The Worker entry module: the `PackageBundler` entrypoint and nothing else.
 * See `./bundle.ts` for why no other export may live here.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { bundlePackage } from "./bundle.ts";
import type {
  BundleRequestV1,
  BundleResultV1,
  BundlerBinding,
} from "./contracts.ts";

export default class PackageBundler
  extends WorkerEntrypoint
  implements BundlerBinding
{
  /** The `PACKAGE_BUNDLER` binding contract. */
  async bundle(request: BundleRequestV1): Promise<BundleResultV1> {
    return bundlePackage(request);
  }

  /** Same contract over HTTP, for local probing. Not used by the DO. */
  override async fetch(request: Request): Promise<Response> {
    let payload: unknown;
    try {
      payload = await request.json();
    } catch (error) {
      payload = { malformed: String(error) };
    }
    return Response.json(await bundlePackage(payload));
  }
}
