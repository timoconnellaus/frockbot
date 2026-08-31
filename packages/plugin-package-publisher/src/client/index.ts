/// <reference path="../env.d.ts" />

// The immutable hosted client mounts this built-in Package Contribution.
import {
  clientSurfaceRegistryKey,
  type ClientPlugin,
} from "@frockbot/client-core";
import { ref } from "vue";
import {
  decodePackagePublicationReceiptV1,
  decodePackageRevisionHistoryV1,
} from "../shared.js";
import PackagePublisherSection from "./PackagePublisherSection.vue";
import PackagePublisherSurface from "./PackagePublisherSurface.vue";
import {
  packagePublisherStateKey,
  type PackagePublisherClientState,
} from "./state.js";

export const packagePublisherClientPlugin: ClientPlugin = (ctx) => {
  const surfaces = ctx.inject(clientSurfaceRegistryKey);
  const state = ref<PackagePublisherClientState>({
    busy: false,
    async load() {
      if (!ctx.transport.hostedRequest) {
        state.value.error = "Package revisions are unavailable";
        return;
      }
      try {
        state.value.history = decodePackageRevisionHistoryV1(
          await ctx.transport.hostedRequest("/api/package-revisions"),
        );
        state.value.error = undefined;
      } catch (error) {
        state.value.error =
          error instanceof Error ? error.message : "Could not load revisions";
      }
    },
    async rollback(packageRevision: number) {
      if (!ctx.transport.hostedRequest || !state.value.history) {
        throw new Error("Package revisions are unavailable");
      }
      state.value.busy = true;
      try {
        decodePackagePublicationReceiptV1(
          await ctx.transport.hostedRequest(
            "/api/package-revisions/rollback",
            "POST",
            JSON.stringify({
              schemaVersion: 1,
              commandId: crypto.randomUUID(),
              expectedRevision: state.value.history.revision,
              packageRevision,
            }),
          ),
        );
        await state.value.load();
      } catch (error) {
        state.value.error =
          error instanceof Error ? error.message : "Rollback failed";
      } finally {
        state.value.busy = false;
      }
    },
  });

  return [
    ctx.provide(packagePublisherStateKey, state),
    surfaces.register({
      id: "package-publisher",
      title: "Published setup",
      component: PackagePublisherSurface,
    }),
    // Revisions are an internal detail: they live inside the User profile's
    // advanced section rather than the sidebar.
    ctx.slot({
      slot: "frockbot.user-settings-sections",
      order: 20,
      component: PackagePublisherSection,
    }),
  ];
};

export default packagePublisherClientPlugin;
