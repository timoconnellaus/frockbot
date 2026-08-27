import type { Component, Ref } from "vue";

export interface Context {
  client: {
    router: {
      slot(options: {
        type: string;
        name?: string;
        order?: number;
        component: Component;
      }): void;
    };
  };
}

export declare function useRpc<T>(): Ref<T>;
