/**
 * Where the host adapter learns about the binaries a PROVIDER declared (C1,
 * `backends/provider-declarations.ts`) without importing the registry, which sits
 * above it: the registry installs a source here for the providers plugins
 * registered, and `binary-path.ts` and `machine.ts` ask. The product's own
 * providers are declared the same way (`backends/builtin-declarations.ts`) and
 * answer first, so the adapter holds no table of CLI names. With no source — a
 * test of the adapter, a daemon with no provider plugin — only the product's own
 * declarations remain.
 */
import { builtinBinaries, type BuiltinBinaryDeclaration, type BuiltinDesktopBuild } from '../backends/builtin-declarations.js';
import type { ProviderBinaryDeclaration } from '../backends/provider-declarations.js';

let source: () => readonly ProviderBinaryDeclaration[] = () => [];

/** Called by the registry. */
export function setDeclaredBinariesSource(fn: () => readonly ProviderBinaryDeclaration[]): void {
  source = fn;
}

/**
 * What a plugin declared, as the public vocabulary: `folderPattern` is the product's
 * own narrowing of a desktop build and a plugin's value for it is never read.
 */
function publicOnly(declaration: ProviderBinaryDeclaration): BuiltinBinaryDeclaration {
  const { desktopBuilds, ...rest } = declaration;
  if (!desktopBuilds) return rest;
  return { ...rest, desktopBuilds: desktopBuilds.map(({ platform, root, executable, order }): BuiltinDesktopBuild => ({ platform, root, executable, order })) };
}

export function declaredBinaries(): readonly BuiltinBinaryDeclaration[] {
  return [...builtinBinaries(), ...source().map(publicOnly)];
}

/** The declaration that names `name` (canonical or alias): the product's own first, then a provider plugin's. */
export function declaredBinary(name: string): BuiltinBinaryDeclaration | undefined {
  return declaredBinaries().find((declaration) => declaration.names.includes(name));
}
