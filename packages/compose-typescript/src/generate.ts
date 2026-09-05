import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import type { Plugin } from "vite";

/** Options for generating one product base's ambient grant declarations. */
export interface GenerateDeclarationsOptions {
  entry: string;
  exportName: string;
  tsconfig?: string;
}

/** Generated ambient text and the content hash that versions it. */
export interface GeneratedDeclarations {
  text: string;
  version: string;
}

const formatFlags =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

/** Generate method-shaped grant declarations from an exported `defineBase`. */
export function generateDeclarations(
  options: GenerateDeclarationsOptions,
): GeneratedDeclarations {
  const entry = resolve(options.entry);
  const configPath = options.tsconfig
    ? resolve(options.tsconfig)
    : ts.findConfigFile(dirname(entry), ts.sys.fileExists);
  let compilerOptions: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
  };
  let rootNames = [entry];
  if (configPath) {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (read.error) throw configurationError(read.error);
    const parsed = ts.parseJsonConfigFileContent(
      read.config,
      ts.sys,
      dirname(configPath),
      undefined,
      configPath,
    );
    if (parsed.errors.length > 0) throw configurationError(parsed.errors[0]!);
    compilerOptions = { ...parsed.options, noEmit: true };
    rootNames = [entry];
  }

  const program = ts.createProgram({ rootNames, options: compilerOptions });
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    );
  if (diagnostics.length > 0) {
    throw new Error(
      `@frockbot/compose-typescript: could not generate declarations\n${ts.formatDiagnosticsWithColorAndContext(
        diagnostics,
        {
          getCanonicalFileName: (fileName) => fileName,
          getCurrentDirectory: ts.sys.getCurrentDirectory,
          getNewLine: () => ts.sys.newLine,
        },
      )}`,
    );
  }

  const file = program.getSourceFile(entry);
  if (!file) {
    throw new Error(
      `@frockbot/compose-typescript: base entry "${entry}" is not in the TypeScript program`,
    );
  }
  const checker = program.getTypeChecker();
  const module = checker.getSymbolAtLocation(file);
  const exported = module
    ? checker
        .getExportsOfModule(module)
        .find((symbol) => symbol.name === options.exportName)
    : undefined;
  const declaration = exported?.valueDeclaration ?? exported?.declarations?.[0];
  if (!exported || !declaration) {
    throw new Error(
      `@frockbot/compose-typescript: "${options.exportName}" is not a value export of "${entry}"`,
    );
  }
  const baseType = checker.getTypeOfSymbolAtLocation(exported, declaration);
  const grantsSymbol = checker.getPropertyOfType(baseType, "grants");
  if (!grantsSymbol) {
    throw new Error(
      `@frockbot/compose-typescript: "${options.exportName}" has no grants property`,
    );
  }
  const grantsType = checker.getTypeOfSymbolAtLocation(
    grantsSymbol,
    declaration,
  );
  const aliases = new Map<string, { symbol: ts.Symbol; type: ts.Type }>();
  const grants: Array<string> = [];
  const grantNames = new Set<string>();

  for (const grantSymbol of checker.getPropertiesOfType(grantsType)) {
    const grantDeclaration =
      grantSymbol.valueDeclaration ??
      grantSymbol.declarations?.[0] ??
      declaration;
    const grantType = checker.getTypeOfSymbolAtLocation(
      grantSymbol,
      grantDeclaration,
    );
    const nameSymbol = checker.getPropertyOfType(grantType, "name");
    const nameType = nameSymbol
      ? checker.getTypeOfSymbolAtLocation(nameSymbol, grantDeclaration)
      : undefined;
    const grantName = nameType?.isStringLiteral()
      ? nameType.value
      : grantSymbol.name;
    if (!identifier(grantName)) {
      throw new Error(
        `@frockbot/compose-typescript: grant name "${grantName}" cannot be an ambient const identifier`,
      );
    }
    if (grantNames.has(grantName)) {
      throw new Error(
        `@frockbot/compose-typescript: grant name "${grantName}" appears more than once`,
      );
    }
    grantNames.add(grantName);
    const methodsSymbol = checker.getPropertyOfType(grantType, "~methods");
    if (!methodsSymbol) {
      throw new Error(
        `@frockbot/compose-typescript: grant "${grantName}" was not created by defineGrant`,
      );
    }
    const methodsType = checker.getNonNullableType(
      checker.getTypeOfSymbolAtLocation(methodsSymbol, grantDeclaration),
    );
    const members: Array<string> = [];
    for (const methodSymbol of checker.getPropertiesOfType(methodsType)) {
      const methodDeclaration =
        methodSymbol.valueDeclaration ??
        methodSymbol.declarations?.[0] ??
        grantDeclaration;
      const methodType = checker.getTypeOfSymbolAtLocation(
        methodSymbol,
        methodDeclaration,
      );
      const signature = checker.getSignaturesOfType(
        methodType,
        ts.SignatureKind.Call,
      )[0];
      if (!signature) continue;
      const authored = signature.getParameters().slice(0, -1);
      const parameters = authored.map((parameter, index) => {
        const parameterDeclaration =
          parameter.valueDeclaration ?? parameter.declarations?.[0];
        const parameterType = checker.getTypeOfSymbolAtLocation(
          parameter,
          parameterDeclaration ?? methodDeclaration,
        );
        collectAliases(program, checker, parameterType, aliases, new Set());
        const rest =
          parameterDeclaration && ts.isParameter(parameterDeclaration)
            ? parameterDeclaration.dotDotDotToken !== undefined
            : false;
        const optional =
          parameterDeclaration && ts.isParameter(parameterDeclaration)
            ? parameterDeclaration.questionToken !== undefined ||
              parameterDeclaration.initializer !== undefined
            : false;
        const name = identifier(parameter.name)
          ? parameter.name
          : `arg${index}`;
        return `${rest ? "..." : ""}${name}${optional ? "?" : ""}: ${checker.typeToString(
          parameterType,
          parameterDeclaration ?? methodDeclaration,
          formatFlags,
        )}`;
      });
      const awaited =
        checker.getAwaitedType(checker.getReturnTypeOfSignature(signature)) ??
        checker.getReturnTypeOfSignature(signature);
      collectAliases(program, checker, awaited, aliases, new Set());
      members.push(
        `  ${propertyName(methodSymbol.name)}(${parameters.join(", ")}): Promise<${checker.typeToString(
          awaited,
          methodDeclaration,
          formatFlags,
        )}>`,
      );
    }
    grants.push(`declare const ${grantName}: {\n${members.join("\n")}\n}`);
  }

  const typeAliases = [...aliases]
    .map(([name, value]) => {
      const aliasDeclaration = value.symbol.declarations?.[0];
      return `type ${name}${typeParametersText(aliasDeclaration)} = ${aliasText(
        checker,
        value.type,
        aliasDeclaration,
      )}`;
    })
    .join("\n\n");
  const body = [typeAliases, grants.join("\n\n")].filter(Boolean).join("\n\n");
  const text = `/** Generated from ${options.exportName}; do not edit. */\n${body}\n`;
  return {
    text,
    version: createHash("sha256").update(text).digest("hex"),
  };
}

function configurationError(diagnostic: ts.Diagnostic): Error {
  return new Error(
    `@frockbot/compose-typescript: ${ts.flattenDiagnosticMessageText(
      diagnostic.messageText,
      "\n",
    )}`,
  );
}

function identifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

function propertyName(name: string): string {
  return identifier(name) ? name : JSON.stringify(name);
}

function collectAliases(
  program: ts.Program,
  checker: ts.TypeChecker,
  type: ts.Type,
  aliases: Map<string, { symbol: ts.Symbol; type: ts.Type }>,
  seen: Set<ts.Type>,
): void {
  if (seen.has(type)) return;
  seen.add(type);
  const symbol = type.aliasSymbol ?? type.getSymbol();
  const belongsToSource = symbol ? sourceSymbol(program, symbol) : false;
  if (symbol && belongsToSource) {
    const name = symbol.name;
    const existing = aliases.get(name);
    if (existing && existing.symbol !== symbol) {
      throw new Error(
        `@frockbot/compose-typescript: generated type name "${name}" is ambiguous`,
      );
    }
    if (!existing) {
      aliases.set(name, { symbol, type });
      for (const declaration of symbol.declarations ?? []) {
        if (
          ts.isInterfaceDeclaration(declaration) ||
          ts.isTypeAliasDeclaration(declaration)
        ) {
          for (const parameter of declaration.typeParameters ?? []) {
            if (parameter.constraint) {
              collectAliases(
                program,
                checker,
                checker.getTypeAtLocation(parameter.constraint),
                aliases,
                seen,
              );
            }
            if (parameter.default) {
              collectAliases(
                program,
                checker,
                checker.getTypeAtLocation(parameter.default),
                aliases,
                seen,
              );
            }
          }
        }
        if (ts.isInterfaceDeclaration(declaration)) {
          for (const clause of declaration.heritageClauses ?? []) {
            for (const inherited of clause.types) {
              collectAliases(
                program,
                checker,
                checker.getTypeAtLocation(inherited),
                aliases,
                seen,
              );
            }
          }
        }
      }
    }
  }
  if (
    (type.flags & ts.TypeFlags.Object) !== 0 &&
    ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0
  ) {
    for (const argument of checker.getTypeArguments(type as ts.TypeReference)) {
      collectAliases(program, checker, argument, aliases, seen);
    }
  }
  if (type.isUnionOrIntersection()) {
    type.types.forEach((member) =>
      collectAliases(program, checker, member, aliases, seen),
    );
  }
  if (
    (type.flags & ts.TypeFlags.Object) === 0 ||
    (symbol !== undefined && !belongsToSource)
  ) {
    return;
  }
  for (const property of checker.getPropertiesOfType(type)) {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (declaration) {
      collectAliases(
        program,
        checker,
        checker.getTypeOfSymbolAtLocation(property, declaration),
        aliases,
        seen,
      );
    }
  }
  for (const signature of [
    ...checker.getSignaturesOfType(type, ts.SignatureKind.Call),
    ...checker.getSignaturesOfType(type, ts.SignatureKind.Construct),
  ]) {
    signature.getParameters().forEach((parameter) => {
      const declaration =
        parameter.valueDeclaration ?? parameter.declarations?.[0];
      if (declaration) {
        collectAliases(
          program,
          checker,
          checker.getTypeOfSymbolAtLocation(parameter, declaration),
          aliases,
          seen,
        );
      }
    });
    collectAliases(
      program,
      checker,
      checker.getReturnTypeOfSignature(signature),
      aliases,
      seen,
    );
  }
}

function sourceSymbol(program: ts.Program, symbol: ts.Symbol): boolean {
  const declarations = symbol.declarations;
  if (!declarations || declarations.length === 0) return false;
  return declarations.some((declaration) => {
    const file = declaration.getSourceFile();
    return (
      (ts.isInterfaceDeclaration(declaration) ||
        ts.isTypeAliasDeclaration(declaration) ||
        ts.isEnumDeclaration(declaration)) &&
      !program.isSourceFileDefaultLibrary(file) &&
      !file.fileName.includes("/node_modules/@types/") &&
      !file.fileName.includes("/node_modules/typescript/lib/")
    );
  });
}

function aliasText(
  checker: ts.TypeChecker,
  type: ts.Type,
  declaration: ts.Declaration | undefined,
): string {
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  if (declaration && ts.isInterfaceDeclaration(declaration)) {
    const own = printer.printNode(
      ts.EmitHint.Unspecified,
      ts.factory.createTypeLiteralNode(declaration.members),
      declaration.getSourceFile(),
    );
    const inherited = (declaration.heritageClauses ?? []).flatMap((clause) =>
      clause.types.map((inheritedType) =>
        printer.printNode(
          ts.EmitHint.Unspecified,
          inheritedType,
          declaration.getSourceFile(),
        ),
      ),
    );
    return [...inherited, own].join(" & ");
  }
  if (declaration && ts.isTypeAliasDeclaration(declaration)) {
    return printer.printNode(
      ts.EmitHint.Unspecified,
      declaration.type,
      declaration.getSourceFile(),
    );
  }
  if (declaration && ts.isEnumDeclaration(declaration)) {
    const values = declaration.members.flatMap((member) => {
      const value = checker.getConstantValue(member);
      return value === undefined ? [] : [JSON.stringify(value)];
    });
    return values.length === 0
      ? "string | number"
      : [...new Set(values)].join(" | ");
  }
  return checker.typeToString(
    type,
    declaration,
    formatFlags | ts.TypeFormatFlags.InTypeAlias,
  );
}

function typeParametersText(declaration: ts.Declaration | undefined): string {
  if (
    !declaration ||
    (!ts.isInterfaceDeclaration(declaration) &&
      !ts.isTypeAliasDeclaration(declaration)) ||
    !declaration.typeParameters?.length
  ) {
    return "";
  }
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  return `<${declaration.typeParameters
    .map((parameter) =>
      printer.printNode(
        ts.EmitHint.Unspecified,
        parameter,
        declaration.getSourceFile(),
      ),
    )
    .join(", ")}>`;
}

/** Options for the Vite virtual declaration module. */
export interface ComposeDeclarationsOptions extends GenerateDeclarationsOptions {
  /** Virtual module id. Defaults to `compose:declarations`. */
  id?: string;
}

/** Serve generated base declarations as a Vite virtual module. */
export function composeDeclarations(
  options: ComposeDeclarationsOptions,
): Plugin {
  const publicId = options.id ?? "compose:declarations";
  const resolvedId = `\0${publicId}`;
  let entry = options.entry;
  let tsconfig = options.tsconfig;
  return {
    name: `tanstack-compose-declarations:${publicId}`,
    enforce: "pre",
    configResolved(resolved) {
      entry = resolve(resolved.root, options.entry);
      tsconfig = options.tsconfig
        ? resolve(resolved.root, options.tsconfig)
        : undefined;
    },
    buildStart() {
      this.addWatchFile(entry);
      if (tsconfig) this.addWatchFile(tsconfig);
    },
    resolveId(id) {
      return id === publicId ? resolvedId : undefined;
    },
    load(id) {
      if (id !== resolvedId) return undefined;
      const generated = generateDeclarations({
        entry,
        exportName: options.exportName,
        ...(tsconfig ? { tsconfig } : {}),
      });
      return `export const text = ${JSON.stringify(generated.text)}\nexport const version = ${JSON.stringify(generated.version)}\nexport default { text, version }\n`;
    },
    handleHotUpdate(context) {
      const module = context.server.moduleGraph.getModuleById(resolvedId);
      if (!module) return undefined;
      context.server.moduleGraph.invalidateModule(module);
      return [module];
    },
  };
}
