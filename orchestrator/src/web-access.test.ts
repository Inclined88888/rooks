import assert from 'node:assert/strict';
import test from 'node:test';
import type { NetworkInterfaceInfo } from 'node:os';
import {
  hostAddresses,
  isLoopbackHost,
  parseTailscaleServe,
  parseTailscaleStatus,
  unreadableOutput,
} from './web-access.js';

/** `networkInterfaces()` shape, minus the fields this module never reads. */
function iface(address: string, family: 'IPv4' | 'IPv6', internal = false): NetworkInterfaceInfo {
  return { address, family, internal, netmask: '', mac: '00:00:00:00:00:00', cidr: null } as NetworkInterfaceInfo;
}

test('loopback hosts are recognised, wildcards are not', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('::1'), true);
  // `0.0.0.0` means every interface — the opposite answer, and mistaking it
  // for the loopback would advertise an exposed listener as local-only.
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('192.168.1.20'), false);
});

test('only addresses a browser could try survive', () => {
  const rows = hostAddresses({
    lo: [iface('127.0.0.1', 'IPv4', true)],
    eth0: [iface('192.168.1.20', 'IPv4'), iface('fe80::1', 'IPv6'), iface('2a01:e0a::1', 'IPv6')],
    docker0: [iface('172.17.0.1', 'IPv4')],
    'br-4f2': [iface('172.20.0.1', 'IPv4')],
    tailscale0: [iface('100.64.0.1', 'IPv4')],
    // A tailnet address on a normally-named interface still belongs to the
    // tailscale section, which carries its DNS name.
    wlan0: [iface('100.64.1.2', 'IPv4'), iface('169.254.7.7', 'IPv4')],
  });
  assert.deepEqual(rows, [
    { iface: 'eth0', address: '192.168.1.20', family: 'ipv4' },
    { iface: 'eth0', address: '2a01:e0a::1', family: 'ipv6' },
  ]);
});

test('tailscale status yields the node name without its trailing dot', () => {
  const parsed = parseTailscaleStatus({
    BackendState: 'Running',
    Self: { DNSName: 'my-laptop.tail0000.ts.net.', TailscaleIPs: ['100.64.0.1', 'fd7a:115c:a1e0::1'] },
  });
  assert.deepEqual(parsed, {
    state: 'Running',
    dnsName: 'my-laptop.tail0000.ts.net',
    addresses: ['100.64.0.1', 'fd7a:115c:a1e0::1'],
  });
});

test('an unreadable status degrades to nothing to show, never throws', () => {
  assert.deepEqual(parseTailscaleStatus(null), { state: null, dnsName: null, addresses: [] });
  assert.deepEqual(parseTailscaleStatus({ Self: { DNSName: 42 } }), { state: null, dnsName: null, addresses: [] });
});

test('a CLI answer that is not JSON keeps its first line for the tab to show', () => {
  assert.equal(
    unreadableOutput('\nThe Tailscale GUI failed to start: (Tailscale.CLIError error 3.)\nmore\n', ''),
    'The Tailscale GUI failed to start: (Tailscale.CLIError error 3.)',
  );
  assert.equal(unreadableOutput('', 'only on stderr'), 'only on stderr');
  assert.equal(unreadableOutput('  \n', ''), null);
});

test('serve handlers are flattened to host → target', () => {
  const rows = parseTailscaleServe({
    TCP: { 443: { HTTPS: true } },
    Web: {
      'my-laptop.tail0000.ts.net:443': {
        Handlers: { '/': { Proxy: 'http://127.0.0.1:80' }, '/files': { Path: '/srv/files' } },
      },
    },
  });
  assert.deepEqual(rows, [
    { host: 'my-laptop.tail0000.ts.net:443', target: 'http://127.0.0.1:80' },
    { host: 'my-laptop.tail0000.ts.net:443/files', target: '/srv/files' },
  ]);
});

test('nothing served is an empty list, not an error', () => {
  assert.deepEqual(parseTailscaleServe(null), []);
  assert.deepEqual(parseTailscaleServe({ TCP: {} }), []);
});
