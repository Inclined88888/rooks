/**
 * Where a provider card stands, and when the onboarding's « Your AIs » step
 * lets the person on to the chat (TODO #251).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerCliState, readyForSetupChat, type ProviderCli } from './provider-clis';

function cli(over: Partial<ProviderCli>): ProviderCli {
  return {
    name: 'claude', label: 'Claude Code', brand: null, path: null, bundled: false, signedIn: null, installable: true,
    installCommand: 'curl -fsSL https://claude.ai/install.sh | bash', installDocs: null, signInCommand: 'claude', signInThen: '/login',
    seedsMainAgent: true, version: null, latest: null, updateAvailable: false, unsupportedVersion: false, ...over,
  };
}

test('a card: missing, desktop build to sign in, installed to sign in, ready', () => {
  assert.equal(providerCliState(cli({})), 'missing');
  assert.equal(providerCliState(cli({ path: '/a/claude', bundled: true, signedIn: false })), 'bundled');
  assert.equal(providerCliState(cli({ path: '/a/claude', signedIn: null })), 'signIn');
  assert.equal(providerCliState(cli({ path: '/a/claude', signedIn: false })), 'signIn');
  assert.equal(providerCliState(cli({ path: '/a/claude', bundled: true, signedIn: true })), 'ready');
});

test('the chat opens on one CLI it can start on, installed and not known to be signed out', () => {
  assert.equal(readyForSetupChat([]), false);
  assert.equal(readyForSetupChat([cli({})]), false, 'nothing installed');
  assert.equal(readyForSetupChat([cli({ path: '/a/codex', signedIn: false })]), false, 'known to be signed out');
  // A provider that cannot tell (Grok, Copilot) must not hold the step forever.
  assert.equal(readyForSetupChat([cli({ path: '/a/grok', signedIn: null })]), true);
  assert.equal(readyForSetupChat([cli({ path: '/a/claude', signedIn: true })]), true);
  // opencode alone: the chat cannot start on it, so it does not open the way.
  assert.equal(readyForSetupChat([cli({ name: 'opencode', path: '/a/opencode', signedIn: true, seedsMainAgent: false })]), false);
});
