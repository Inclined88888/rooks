export function readDataVersion(home: string): string | null;
export function approvedUpdateVersion(home: string): string | null;
export function localUpdateOffer(home: string, version: string, compareVersions: (a: string, b: string) => number | null): { from: string; to: string } | null;
