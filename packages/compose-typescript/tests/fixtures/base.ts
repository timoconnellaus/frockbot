import { defineBase, defineGrant } from "@frockbot/compose-core/base";
import type { GrantContext } from "@frockbot/compose-core/base";

export interface RecordRow {
  id: number;
  label: string;
}

const data = defineGrant({
  name: "data",
  methods: {
    rows(
      filter: { prefix?: string },
      _context: GrantContext,
    ): Array<RecordRow> {
      return [{ id: 1, label: filter.prefix ?? "one" }];
    },
  },
});

export const testBase = defineBase({
  keys: {},
  actions: {},
  slots: {},
  grants: { data },
  plugins: {},
});
