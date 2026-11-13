import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticFileName, listenLabel, serviceState, versionGap, type ServiceReport } from './system-info';

const SERVICE: ServiceReport = {
  supervisor: 'windows', name: 'RooksOrchestrator', installed: true, running: true, reason: null,
  windows: null, stale: false, action: null, actionHere: false, command: 'rooks service install',
};

test('serviceState: stale wins over running, no supervisor is its own state', () => {
  assert.equal(serviceState(SERVICE), 'running');
  assert.equal(serviceState({ ...SERVICE, running: false }), 'stopped');
  assert.equal(serviceState({ ...SERVICE, stale: true }), 'stale');
  assert.equal(serviceState({ ...SERVICE, installed: false }), 'absent');
  assert.equal(serviceState({ ...SERVICE, supervisor: null, installed: false }), 'unsupported');
});

test('versionGap: only an app that reports a different version', () => {
  assert.equal(versionGap('0.1.5', '0.1.5'), false);
  assert.equal(versionGap('0.1.3', '0.1.5'), true);
  assert.equal(versionGap('0.1.5', null), false);
});

test('listenLabel: every interface is said, IPv6 is bracketed', () => {
  assert.deepEqual(listenLabel('::', 3010), { address: '[::]:3010', everywhere: true });
  assert.deepEqual(listenLabel('127.0.0.1', 3001), { address: '127.0.0.1:3001', everywhere: false });
  assert.deepEqual(listenLabel(null, 3001), { address: ':3001', everywhere: false });
});

test('diagnosticFileName: the desktop\'s saved-report name, local time', () => {
  assert.equal(diagnosticFileName(new Date(2026, 9, 13, 19, 6, 11)), 'rooks-diagnostic-20261013-190611.txt');
});
