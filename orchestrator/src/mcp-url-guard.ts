/**
 * Where an MCP server url declared by a caller that is not the operator (a
 * mission without `agents:privileged-config`, a plugin) may point: a PUBLIC
 * address that is not one of this host's own.
 *
 * The name a url spells proves nothing: `mcp.attacker.example` can resolve to
 * 127.0.0.1, to the LAN or to a metadata endpoint, and every attached agent's
 * CLI then talks to it outside the permission classifier (TODO #530). So the
 * judgement is on the RESOLVED addresses, every one of them, and it is made
 * twice: when the server is written (`skills-mcp-guard.ts`) and again when a
 * mission is launched with it (`mcp.ts`, `resolveLaunchServers`), since a DNS
 * record can be changed after the write.
 *
 * Standalone on purpose (node built-ins and `net-guard.ts` only): `mcp.ts`
 * imports it, and must not pull the request/permission layer with it.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { classifyAddress, DestinationRefusedError, type AddressKind, type AddressLookup, type ResolvedAddress } from './plugins/net-guard.js';

const defaultLookup: AddressLookup = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => ({ address: answer.address, family: answer.family === 6 ? 6 : 4 }));
};

let lookupForTest: AddressLookup | null = null;
let ownAddressesForTest: readonly string[] | null = null;
let publicAddressesForTest: readonly string[] = [];

/**
 * Tests resolve names without the network and, when given, see `ownAddresses`
 * as this host's interfaces and `publicAddresses` as public (a witness server
 * can only listen on the loopback); `null` restores DNS and the real interfaces.
 */
export function setMcpHostLookupForTest(
  fn: AddressLookup | null, ownAddresses?: readonly string[], publicAddresses?: readonly string[],
): void {
  lookupForTest = fn;
  ownAddressesForTest = fn ? ownAddresses ?? null : null;
  publicAddressesForTest = fn ? publicAddresses ?? [] : [];
}

function kindOf(address: string): AddressKind {
  return publicAddressesForTest.includes(bare(address)) ? 'public' : classifyAddress(address);
}

function interfaceAddresses(): string[] {
  if (ownAddressesForTest) return [...ownAddressesForTest];
  return Object.values(networkInterfaces()).flatMap((entries) => (entries ?? []).map((entry) => entry.address));
}

const KIND_LABEL: Record<Exclude<AddressKind, 'public'>, string> = {
  blocked: 'a link-local, metadata or reserved address',
  loopback: 'this host',
  private: 'the local network',
  tailscale: 'a Tailscale network',
};

function bare(address: string): string {
  return address.split('%')[0]!.toLowerCase();
}

/**
 * One of this machine's own interface addresses: a daemon that listens beyond
 * the loopback is reached there under a public address too.
 */
function isOwnAddress(address: string): boolean {
  const wanted = bare(address);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(wanted)?.[1];
  return interfaceAddresses().some((own) => bare(own) === wanted || bare(own) === mapped);
}

/**
 * Why `hostname` (as `URL.hostname` gives it) is not a public address off this
 * host, or null. A name that does not resolve is refused too: what cannot be
 * proven safe is refused.
 */
export async function mcpHostAddressRefusal(hostname: string): Promise<string | null> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return addressRefusal(host, `${host} is`);
  let addresses: string[];
  try {
    addresses = (await (lookupForTest ?? defaultLookup)(host)).map((entry) => entry.address);
  } catch {
    addresses = [];
  }
  return answersRefusal(host, addresses);
}

function addressRefusal(address: string, where: string): string | null {
  const kind = kindOf(address);
  if (kind !== 'public') return `${where} ${KIND_LABEL[kind]}`;
  if (isOwnAddress(address)) return `${where} one of this host's own addresses`;
  return null;
}

/** EVERY answer must pass: a socket handed a public and a loopback address may pick either. */
function answersRefusal(host: string, addresses: readonly string[]): string | null {
  if (addresses.length === 0) return `${host} does not resolve`;
  for (const address of addresses) {
    const refusal = addressRefusal(address, `${host} resolves to ${address},`);
    if (refusal) return refusal;
  }
  return null;
}

/**
 * The same judgement for the socket that connects (`mcp-launch-proxy.ts`): an
 * address literal, refused by a throw. A name returns null — `mcpPinnedLookup`
 * judges it, on the very answers the socket is then pinned to.
 */
export function assertMcpLiteralAllowed(hostname: string): void {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (!isIP(host)) return;
  const refusal = addressRefusal(host, `${host} is`);
  if (refusal) throw new DestinationRefusedError(refusal);
}

/**
 * A lookup for `guardedFetch` that resolves once and refuses the whole answer
 * unless every address is public and none is this host's: what it returns is
 * what the socket connects to, so a record switched after this check is never
 * reached (DNS rebinding between check and connect).
 */
export const mcpPinnedLookup: AddressLookup = async (hostname) => {
  let answers: ResolvedAddress[];
  try {
    answers = await (lookupForTest ?? defaultLookup)(hostname);
  } catch {
    answers = [];
  }
  const refusal = answersRefusal(hostname, answers.map((entry) => entry.address));
  if (refusal) throw new DestinationRefusedError(refusal);
  return answers;
};
