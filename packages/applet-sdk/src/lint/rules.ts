/**
 * The five rules that keep an Applet inside the SDK.
 *
 * Each one exists because of a way an Applet can look right and be wrong: a
 * hard-coded colour that ignores the user's theme, a network call the loader
 * would block anyway, an import that will not exist at build time, and state
 * or tools declared in a shape the server cannot see. ADR 0022 decision 10
 * says this set grows from observed failures — add a rule and a test here,
 * never a paragraph in a prompt.
 */

/** A syntax node, walked structurally so no parser type leaks into the rules. */
export interface AstNode {
  type: string;
  [field: string]: unknown;
}

export interface RuleContext {
  report(descriptor: { node: AstNode; message: string }): void;
}

export interface AppletRule {
  meta: {
    type: "problem" | "suggestion";
    docs: { description: string };
    schema: [];
    messages?: Record<string, string>;
  };
  create(context: RuleContext): Record<string, (node: AstNode) => void>;
}

function child(node: AstNode | undefined, field: string): AstNode | undefined {
  const value = node?.[field];
  return value && typeof value === "object" ? (value as AstNode) : undefined;
}

function name(node: AstNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "Identifier" && typeof node.name === "string")
    return node.name;
  if (node.type === "Literal" && typeof node.value === "string")
    return node.value;
  return undefined;
}

function list(node: AstNode | undefined, field: string): AstNode[] {
  const value = node?.[field];
  return Array.isArray(value) ? (value as AstNode[]) : [];
}

// ---------------------------------------------------------------------------
// no-raw-colors
// ---------------------------------------------------------------------------

const FUNCTIONAL_COLOR =
  /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(|\bcolor-mix\s*\(/;
const NAMED_COLORS = new Set([
  "aqua",
  "black",
  "blue",
  "brown",
  "cyan",
  "fuchsia",
  "gold",
  "gray",
  "green",
  "grey",
  "indigo",
  "lime",
  "magenta",
  "maroon",
  "navy",
  "olive",
  "orange",
  "pink",
  "purple",
  "red",
  "silver",
  "teal",
  "violet",
  "white",
  "yellow",
]);
const COLOR_PROPERTIES = new Set([
  "color",
  "background",
  "backgroundColor",
  "borderColor",
  "borderTopColor",
  "borderRightColor",
  "borderBottomColor",
  "borderLeftColor",
  "outlineColor",
  "fill",
  "stroke",
  "caretColor",
  "accentColor",
  "textDecorationColor",
  "boxShadow",
  "textShadow",
]);

/**
 * A colour literal is fine only where the same value is anchored to a theme
 * token: as a `var(--frockbot-x, #fallback)` fallback, or as an ingredient of a
 * `color-mix()` over one. Anything else is a colour the User's theme cannot
 * move.
 */
export function anchoredToToken(text: string): boolean {
  return /var\(\s*--frockbot-[a-z-]+/.test(text);
}

export const noRawColors: AppletRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Colours come from the nine --frockbot-* theme tokens, never from a literal",
    },
    schema: [],
  },
  create(context) {
    const flag = (node: AstNode, text: string) => {
      if (anchoredToToken(text)) return;
      if (!FUNCTIONAL_COLOR.test(text)) return;
      context.report({
        node,
        message:
          "Use a --frockbot-* theme token instead of a colour literal " +
          "(the kit's components already do).",
      });
    };
    return {
      Literal(node) {
        if (typeof node.value === "string") flag(node, node.value);
      },
      TemplateElement(node) {
        const value = child(node, "value");
        const raw = value?.raw;
        if (typeof raw === "string") flag(node, raw);
      },
      Property(node) {
        const key = name(child(node, "key"));
        if (!key || !COLOR_PROPERTIES.has(key)) return;
        const value = child(node, "value");
        if (value?.type !== "Literal" || typeof value.value !== "string")
          return;
        const text = value.value.trim().toLowerCase();
        if (anchoredToToken(text) || !NAMED_COLORS.has(text)) return;
        context.report({
          node: value,
          message: `"${text}" is a raw colour; use a --frockbot-* theme token.`,
        });
      },
    };
  },
};

// ---------------------------------------------------------------------------
// no-network
// ---------------------------------------------------------------------------

const FORBIDDEN_CONSTRUCTORS = new Set([
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
]);

export const noNetwork: AppletRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "An Applet reaches the outside world through its tools, never directly",
    },
    schema: [],
  },
  create(context) {
    const complain = (node: AstNode, what: string) =>
      context.report({
        node,
        message:
          `${what} is not available to an Applet: the loader runs it with no ` +
          "outbound network. Add a tool on the server, or use the Applet socket.",
      });
    return {
      CallExpression(node) {
        const callee = child(node, "callee");
        if (name(callee) === "fetch") {
          complain(node, "fetch()");
          return;
        }
        if (callee?.type !== "MemberExpression") return;
        const property = name(child(callee, "property"));
        const object = name(child(callee, "object"));
        if (
          property === "fetch" &&
          (object === "window" || object === "globalThis")
        ) {
          complain(node, "fetch()");
        }
        if (property === "sendBeacon" && object === "navigator") {
          complain(node, "navigator.sendBeacon()");
        }
      },
      NewExpression(node) {
        const callee = name(child(node, "callee"));
        if (callee && FORBIDDEN_CONSTRUCTORS.has(callee))
          complain(node, `new ${callee}`);
      },
    };
  },
};

// ---------------------------------------------------------------------------
// allowed-imports
// ---------------------------------------------------------------------------

function importAllowed(specifier: string): boolean {
  if (specifier.startsWith(".")) return true;
  if (specifier === "react" || specifier.startsWith("react/")) return true;
  return (
    specifier === "@frockbot/applet-sdk" ||
    specifier.startsWith("@frockbot/applet-sdk/")
  );
}

export const allowedImports: AppletRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "An Applet bundles from @frockbot/applet-sdk, react, and its own files only",
    },
    schema: [],
  },
  create(context) {
    const check = (node: AstNode, source: AstNode | undefined) => {
      const specifier = source?.type === "Literal" ? source.value : undefined;
      if (typeof specifier !== "string" || importAllowed(specifier)) return;
      context.report({
        node,
        message:
          `"${specifier}" cannot be imported: an Applet may import ` +
          "@frockbot/applet-sdk/*, react, and its own relative files.",
      });
    };
    return {
      ImportDeclaration: (node) => check(node, child(node, "source")),
      ExportNamedDeclaration: (node) => check(node, child(node, "source")),
      ExportAllDeclaration: (node) => check(node, child(node, "source")),
      ImportExpression: (node) => check(node, child(node, "source")),
      CallExpression(node) {
        if (name(child(node, "callee")) !== "require") return;
        check(node, list(node, "arguments")[0]);
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Class-shape rules
// ---------------------------------------------------------------------------

function isAppletClassBody(node: AstNode): boolean {
  const parent = child(node, "parent");
  return name(child(parent, "superClass")) === "Applet";
}

function declaredProperty(node: AstNode, field: string): AstNode | undefined {
  for (const member of list(node, "body")) {
    if (member.type !== "PropertyDefinition") continue;
    if (name(child(member, "key")) === field) return member;
  }
  return undefined;
}

export const tablesViaTable: AppletRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Tables are declared with table() so the SDK can derive DDL",
    },
    schema: [],
  },
  create(context) {
    // `tables = tables` naming a `const tables = { … }` is the shape the
    // template uses, so the rule follows one level of indirection. The lookup
    // happens on `Program:exit` so the declaration may come after the class.
    const objectsByName = new Map<string, AstNode>();
    const classBodies: AstNode[] = [];
    return {
      VariableDeclarator(node) {
        const identifier = name(child(node, "id"));
        const init = child(node, "init");
        if (identifier && init?.type === "ObjectExpression") {
          objectsByName.set(identifier, init);
        }
      },
      ClassBody(node) {
        if (isAppletClassBody(node)) classBodies.push(node);
      },
      "Program:exit"() {
        for (const body of classBodies) {
          const property = declaredProperty(body, "tables");
          if (!property) continue;
          const declared = child(property, "value");
          const value =
            declared?.type === "Identifier"
              ? objectsByName.get(name(declared) ?? "")
              : declared;
          if (value?.type !== "ObjectExpression") {
            context.report({
              node: property,
              message:
                "`tables` must be an object literal of table({ … }) declarations.",
            });
            continue;
          }
          for (const entry of list(value, "properties")) {
            const declaration = child(entry, "value");
            if (
              declaration?.type === "CallExpression" &&
              name(child(declaration, "callee")) === "table"
            ) {
              continue;
            }
            context.report({
              node: entry,
              message:
                "Each table must be declared with table({ … }) from the SDK.",
            });
          }
        }
      },
    };
  },
};

export const toolsViaThisTool: AppletRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Tools are declared with this.tool() so health() can report them",
    },
    schema: [],
  },
  create(context) {
    return {
      ClassBody(node) {
        if (!isAppletClassBody(node)) return;
        const property = declaredProperty(node, "tools");
        if (!property) return;
        const value = child(property, "value");
        if (value?.type !== "ObjectExpression") {
          context.report({
            node: property,
            message:
              "`tools` must be an object literal of this.tool(…) declarations.",
          });
          return;
        }
        for (const entry of list(value, "properties")) {
          const declaration = child(entry, "value");
          const callee = child(declaration, "callee");
          if (
            declaration?.type === "CallExpression" &&
            callee?.type === "MemberExpression" &&
            child(callee, "object")?.type === "ThisExpression" &&
            name(child(callee, "property")) === "tool"
          ) {
            continue;
          }
          context.report({
            node: entry,
            message:
              "Each tool must be declared with this.tool({ … }, handler).",
          });
        }
      },
    };
  },
};

export const appletRules = {
  "no-raw-colors": noRawColors,
  "no-network": noNetwork,
  "allowed-imports": allowedImports,
  "tables-via-table": tablesViaTable,
  "tools-via-this-tool": toolsViaThisTool,
} satisfies Record<string, AppletRule>;

export type AppletRuleName = keyof typeof appletRules;
