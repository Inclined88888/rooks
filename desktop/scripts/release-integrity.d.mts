export const protectedRoots: string[];
export const RELEASE_MANIFEST_VERSION: number;
export function productFiles(root: string): string[];
export function digest(path: string): string;
export function verifyRelease(root: string, publicKey: string): {
  version: number;
  files: Record<string, string>;
};
