/// <reference path="../env.d.ts" />

import {
  clientSurfaceRegistryKey,
  type ClientPlugin,
} from "@frockbot/client-core";
import AdminSurface from "./AdminSurface.vue";
import { adminRequestKey } from "./state.js";

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
