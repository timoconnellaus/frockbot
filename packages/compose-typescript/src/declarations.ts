/**
 * The plugin declarations: the types a written plugin is checked against and
 * its author is shown (self-modification D8). The text this module produces is
 * the text the checker compiles against, byte for byte — there is one producer,
 * so what type-checks is what runs.
 */

/** One grant, as the check request carries it: a name and its `.d.ts` text. */
export interface GrantDeclarations {
  /** The name this stub appears under in the plugin's `stubs` object. */
  readonly name: string;
  /** The `.d.ts` text the grant's `createStub` carries. */
  readonly declarations: string;
}

/**
 * The written plugin shape, identical for every entry: the module's default
 * export, what it is handed, and what its named exports are. Everything an
 * entry does not share with every other entry comes from its grants.
 */
export const baseDeclarations = `/**
 * A written plugin is an ES module. Its default export is \`setup\`, which the
 * client runs once when the instance starts; every other named export is a
 * handler the client can call by name.
 *
 * This file is the whole of the environment the module is compiled in: the
 * ES2022 built-ins, these declarations, and nothing else. There is no DOM, no
 * \`console\`, no \`process\`, no filesystem, and no module to import. If a
 * written plugin can do it, a stub was granted for it.
 *
 * Values only cross the boundary as structured-clone-safe data — plain objects,
 * arrays and primitives. A function, a class instance or a live handle passed
 * to a stub or returned from a handler fails at the boundary, in every host.
 */

/** Undoes what the module itself holds; the client runs it when the instance is removed. */
type Cleanup = () => void | Promise<void>

/** What \`setup\` is handed. */
interface SetupArgument {
  /** This instance's id, as it appears in the plugin list. */
  readonly id: string
  /** The instance's validated options. Narrow it before you use it. */
  readonly options: unknown
  /** Exactly the stubs this entry was granted, and nothing else. */
  readonly stubs: Stubs
}

/**
 * The module's default export. Annotate it — \`const setup: Setup = …\` — and
 * the argument is typed for you.
 *
 * @example
 * \`\`\`ts
 * const setup: Setup = async ({ id, options, stubs }) => {
 *   // register what this plugin contributes, through its stubs
 *   return () => {
 *     // release anything this module itself holds
 *   }
 * }
 * export default setup
 * \`\`\`
 */
type Setup = (argument: SetupArgument) => void | Cleanup | Promise<void | Cleanup>

/**
 * Every named export of this module is a handler. The client calls it by name
 * with one structured-clone-safe argument and clones the result back. (\`never\`
 * as the parameter type is how this rule says "declare whatever input your
 * handler expects"; it does not mean the handler takes nothing.)
 *
 * @example
 * \`\`\`ts
 * export async function add(input: { a: number; b: number }) {
 *   return input.a + input.b
 * }
 * \`\`\`
 */
type Handler = (input: never) => unknown
`;

/**
 * The full declaration text an entry with these grants is checked against: the
 * base declarations, the grants' own text in grant order, and the \`stubs\`
 * object type synthesized from the grant names.
 *
 * Hand this to the model and what it writes against it is what the checker
 * checks and the host runs (D8).
 *
 * @example
 * ```ts
 * const text = pluginDeclarations([
 *   { name: 'tools', declarations: toolsStub.declarations },
 * ])
 * ```
 */
export function pluginDeclarations(
  grants: ReadonlyArray<GrantDeclarations>,
  productBase = "",
): string {
  const granted = grants
    .map(
      (grant) =>
        `// The "${grant.name}" stub.\n${grant.declarations.replace(/\n+$/, "")}\n`,
    )
    .join("\n");
  const members = grants
    .map(
      (grant) => `  readonly ${memberName(grant.name)}: typeof ${grant.name}\n`,
    )
    .join("");
  const stubs =
    members === ""
      ? `/** The stubs this entry was granted. */\ninterface Stubs {}\n`
      : `/** The stubs this entry was granted. */\ninterface Stubs {\n${members}}\n`;
  const generated =
    productBase === "" ? "" : `${productBase.replace(/\n+$/, "")}\n\n`;
  return `${baseDeclarations}\n${generated}${granted}${granted === "" ? "" : "\n"}${stubs}`;
}

/** A grant name as an interface member: quoted when it is not an identifier. */
function memberName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}
