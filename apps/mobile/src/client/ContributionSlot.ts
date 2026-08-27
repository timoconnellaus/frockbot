import { defineComponent, h, type PropType } from "vue";
import type { ContributionRegistry } from "./contribution-registry.ts";

export function createContributionSlot(registry: ContributionRegistry) {
  return defineComponent({
    name: "ContributionSlot",
    props: {
      name: { type: String as PropType<string>, required: true },
    },
    setup(props) {
      return () => {
        const components = registry.componentsFor(props.name);
        if (components.length === 0) return null;
        return components.map((component, index) =>
          h(component, { key: `${props.name}:${index}` }),
        );
      };
    },
  });
}
