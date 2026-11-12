/**
 * The shape of an Apps catalogue entry (docs/MCP-APPS.md §3): one JSON file
 * per publisher in `catalog/`, reviewed by hand, never written by a tool.
 *
 * Strict on purpose: an unknown key is a typo in a reviewed file, and a typo
 * that silently drops a field (`privacy` spelt `privacey`) ships a card without
 * its policy link.
 */
import { z } from 'zod';

export const APP_CATEGORIES = ['code', 'data', 'design', 'productivity', 'business'] as const;
export type AppCategory = typeof APP_CATEGORIES[number];

const https = z.string().max(2_048).refine((value) => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}, 'must be an https URL');

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

const text = (max: number) => z.string().trim().min(1).max(max);
const localized = (max: number) => z.object({ en: text(max), fr: text(max) }).strict();
const examples = z.array(text(160)).min(2).max(3);

/**
 * How the agent's requests are authenticated. `oauth`: the MCP authorization
 * flow of `oauth.ts`, which needs dynamic client registration (RFC 7591).
 * `key`: a token the user pastes, kept in the vault and sent as `header`
 * (`prefix` + value). `none`: the endpoint answers anonymous calls.
 */
const auth = z.discriminatedUnion('type', [
  z.object({ type: z.literal('oauth') }).strict(),
  z.object({
    type: z.literal('key'),
    header: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/),
    prefix: z.string().max(16).regex(/^[A-Za-z0-9 _-]*$/).optional(),
    /** Where the publisher lets a user create the key. */
    help_url: https,
    label: localized(60),
  }).strict(),
  z.object({ type: z.literal('none') }).strict(),
]);

/**
 * Why the entry is the publisher's own (docs/MCP-APPS.md §2). `domain`: the
 * registry verified the namespace by domain and the endpoint is hosted on that
 * domain. `documented`: the namespace is verified (domain or GitHub
 * organisation) but the endpoint lives elsewhere; `evidence` is a page of the
 * publisher that names the endpoint.
 */
const registry = z.discriminatedUnion('proof', [
  z.object({ name: z.string().regex(/^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+$/), proof: z.literal('domain') }).strict(),
  z.object({ name: z.string().regex(/^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+$/), proof: z.literal('documented'), evidence: https }).strict(),
]);

export const appEntrySchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  name: text(40),
  publisher: text(60),
  category: z.enum(APP_CATEGORIES),
  tagline: localized(90),
  description: localized(420),
  examples: z.object({ en: examples, fr: examples }).strict(),
  mcp: z.object({
    url: https,
    // `type: "http"` of the agents' MCP configurations is streamable HTTP:
    // an SSE-only endpoint would be written in a shape no CLI reads.
    transport: z.literal('streamable-http'),
  }).strict(),
  auth,
  links: z.object({ website: https, privacy: https, terms: https }).strict(),
  registry,
  /**
   * The brand tile: `color` is its background, `monogram` what a card paints
   * when there is no `logo`. `logo` is the publisher's mark as SVG path data,
   * painted with `fill` or, without it, in the ink that reads on `color`.
   * Path data rather than SVG markup: a card draws `<path d>` itself, so a
   * reviewed file can never carry a script or an external reference.
   */
  icon: z.object({
    monogram: z.string().regex(/^[A-Za-z0-9]{1,2}$/),
    color: hexColor,
    logo: z.object({
      viewBox: z.string().regex(/^-?\d+(\.\d+)? -?\d+(\.\d+)? \d+(\.\d+)? \d+(\.\d+)?$/),
      paths: z.array(z.object({
        d: z.string().min(1).max(12_000).regex(/^[MmZzLlHhVvCcSsQqTtAa0-9eE.,\s+-]+$/),
        fill: hexColor.optional(),
      }).strict()).min(1).max(8),
      /** Where the mark was taken from: Simple Icons (CC0 drawings) or the publisher's own site. */
      source: https,
    }).strict().optional(),
  }).strict(),
  reviewed: z.object({
    on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** What the live probe answered on that day (`node scripts/mcp-apps-catalog.mjs probe`). */
    probe: text(200),
  }).strict(),
}).strict();

export type AppEntry = z.infer<typeof appEntrySchema>;
export type AppAuth = AppEntry['auth'];
