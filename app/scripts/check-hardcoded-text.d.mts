// Types of check-hardcoded-text.mjs, for the TypeScript tests that import it.

export type HardcodedKind = 'jsxText' | 'jsxAttr' | 'french';
export interface HardcodedFinding { readonly kind: HardcodedKind; readonly line: number; readonly text: string }
export type HardcodedCounts = Record<string, Partial<Record<HardcodedKind, number>>>;

export const KINDS: HardcodedKind[];
export const DEFAULT_ROOTS: { dir: string; kinds: HardcodedKind[] }[];
export const BASELINE_FILE: string;

export function findHardcodedText(text: string, name: string, kinds?: HardcodedKind[]): HardcodedFinding[];
export function scanHardcodedText(roots?: { dir: string; kinds: HardcodedKind[] }[]): Record<string, HardcodedFinding[]>;
export function countByFile(byFile: Record<string, HardcodedFinding[]>): HardcodedCounts;
export function readBaseline(file?: string): HardcodedCounts;
export function compareToBaseline(byFile: Record<string, HardcodedFinding[]>, baseline: HardcodedCounts): {
  over: { file: string; kind: HardcodedKind; count: number; allowed: number; findings: HardcodedFinding[] }[];
  under: { file: string; kind: HardcodedKind; count: number; allowed: number }[];
};
