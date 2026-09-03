/// <reference path="../env.d.ts" />

import {
  clientSurfaceRegistryKey,
  type ClientPlugin,
} from "@frockbot/client-core";
import AdminSurface from "./AdminSurface.vue";
import { adminRequestKey } from "./state.js";
import { defineClientContribution } from "@frockbot/kernel-contracts/contributions";

export const ADMIN_SURFACE_ID = "admin";

export const adminClientPlugin: ClientPlugin = (ctx) => {
  if (!ctx.transport.hostedRequest) {
    throw new Error("Admin hosted transport is unavailable");
  }
  const request = ctx.transport.hostedRequest.bind(ctx.transport);
  const surfaces = ctx.inject(clientSurfaceRegistryKey);
  return [
    ctx.provide(adminRequestKey, request),
    surfaces.register({
      id: ADMIN_SURFACE_ID,
      title: "Admin",
      component: AdminSurface,
    }),
  ];
};

export default adminClientPlugin;

/**
 * The manifest's `client` entry, resolved by specifier. The application looks
 * this descriptor up in its Contribution table; it never branches on which
 * Package it belongs to.
 */
export const clientContribution = defineClientContribution<ClientPlugin>({
  specifier: "@frockbot/plugin-admin/client",
  plugin: adminClientPlugin,
});
