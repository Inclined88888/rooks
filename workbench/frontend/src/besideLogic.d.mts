export const BESIDE_KEY: string;
export const BESIDE_SCREENS: readonly { id: string; label: string; path: string }[];
export function suggestBeside(pathname: string): string;
export function clampRatio(n: number): number;
export function screenPath(path: string): string;
export function screenLabel(path: string): string;
export function safePath(path: string): boolean;
export function readStoredBeside(
  storage: { getItem(key: string): string | null } | null,
): { path: string; ratio: number } | null;
export function writeStoredBeside(
  storage: { setItem(key: string, value: string): void; removeItem(key: string): void } | null,
  value: { path: string; ratio: number } | null,
): void;
