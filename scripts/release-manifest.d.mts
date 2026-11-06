import type { KeyObject } from 'node:crypto';

export type ReleaseChannel = 'beta' | 'stable';
export type ArtifactKey = `${'linux' | 'mac' | 'win'}-${'x64' | 'arm64' | 'universal'}-${'appimage' | 'deb' | 'pkg' | 'dmg' | 'nsis'}`;
export interface ReleaseArtifact { name: string; url: string; size: number; sha256: string }
export interface ReleaseChannelEntry { version: string; publishedAt: string; notesUrl: string; notes: string; artifacts: Partial<Record<ArtifactKey, ReleaseArtifact>> }
export interface ReleasesPayload { schema: 1; issuedAt: string; expiresAt: string; channels: Partial<Record<ReleaseChannel, ReleaseChannelEntry>> }
export interface ReleasesEnvelope { keyId: string; payload: string; sig: string }
export interface ReleasePublicKey { keyId: string; publicKey: string; expiresAt?: string }

export const RELEASES_SCHEMA: 1;
export const RELEASES_SIGNATURE_DOMAIN: string;
export const RELEASES_URL: string;
export const CHANNELS: readonly ReleaseChannel[];
export const NOTES_MAX: number;
export const ENVELOPE_MAX: number;
export const CLOCK_SKEW_MS: number;
export const DEFAULT_VALID_DAYS: number;
export function isVersion(value: unknown): boolean;
export function isPrerelease(version: string): boolean;
export function compareVersions(a: string, b: string): -1 | 0 | 1;
export function channelsFor(version: string): ReleaseChannel[];
export function keyIdFor(publicKey: string | KeyObject): string;
export function releaseKeyPair(privatePem: string | Buffer, publicPem: string | Buffer): { privateKey: KeyObject; publicKey: string; keyId: string };
export function validateReleasesPayload(payload: unknown): ReleasesPayload;
export function boundNotes(text: string, max?: number): string;
export function composeReleasesPayload(input: { previous?: ReleasesPayload | null; entry: ReleaseChannelEntry; now?: Date; validDays?: number }): { payload: ReleasesPayload; changed: ReleaseChannel[] };
export function signReleasesPayload(payload: ReleasesPayload, key: { privateKey: KeyObject; keyId: string }): ReleasesEnvelope;
export function serializeEnvelope(envelope: ReleasesEnvelope): string;
export function verifyReleaseManifest(input: string | Buffer | ReleasesEnvelope, keyring: readonly ReleasePublicKey[], options?: { now?: Date; minIssuedAt?: string | null; allowExpired?: boolean }): ReleasesPayload;
