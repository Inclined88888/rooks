import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { interpretUsageResponse, usageShouldKeepPolling } from './account-usage';
import { AccountUsageStatus } from '@/components/account-usage-status';
import { setLocale } from './i18n';

test('200 connected=false is idle, not an error, and stops polling', () => {
  const view = interpretUsageResponse(200, {
    backend: 'claude',
    supported: true,
    connected: false,
    reason: 'not_signed_in',
  });
  assert.deepEqual(view, { kind: 'disconnected', backend: 'claude' });
  assert.equal(usageShouldKeepPolling(view), false);
});

test('503 stays an error even when the body repeats the login sentence', () => {
  const view = interpretUsageResponse(503, {
    backend: 'claude',
    error: 'No Claude Code OAuth session; run `/login` in the CLI and retry',
  });
  assert.equal(view.kind, 'error');
  if (view.kind !== 'error') return;
  assert.match(view.message, /OAuth session/);
  assert.equal(usageShouldKeepPolling(view), true);
});

test('200 supported=false is unsupported, 200 with usage is ok', () => {
  assert.equal(interpretUsageResponse(200, { backend: 'codex', supported: false, reason: 'none' }).kind, 'unsupported');
  assert.equal(interpretUsageResponse(200, {
    backend: 'claude',
    supported: true,
    connected: true,
    windows: {},
  }).kind, 'ok');
  assert.equal(usageShouldKeepPolling({ kind: 'ok' }), true);
  assert.equal(usageShouldKeepPolling({ kind: 'unsupported' }), true);
});

test('disconnected render is a status, 503 render is an alert', () => {
  setLocale('en');
  const idle = renderToStaticMarkup(React.createElement(AccountUsageStatus, {
    view: { kind: 'disconnected', backend: 'claude' },
    provider: { label: 'Claude', signInCommand: 'claude', signInThen: '/login' },
  }));
  assert.match(idle, /role="status"/);
  assert.doesNotMatch(idle, /role="alert"/);
  assert.doesNotMatch(idle, /text-destructive/);
  assert.match(idle, /Not signed in/);
  assert.match(idle, /Sign in to Claude from the CLI: run claude, then \/login/);

  const failed = renderToStaticMarkup(React.createElement(AccountUsageStatus, {
    view: { kind: 'error', message: 'oauth/usage 502: provider exploded' },
  }));
  assert.match(failed, /role="alert"/);
  assert.match(failed, /text-destructive/);
  assert.match(failed, /Usage unavailable/);
  assert.match(failed, /provider exploded/);
  assert.doesNotMatch(failed, /Not signed in/);
});

test('a signed-out Copilot points at copilot login (TIM-0050)', () => {
  setLocale('en');
  const idle = renderToStaticMarkup(React.createElement(AccountUsageStatus, {
    view: { kind: 'disconnected', backend: 'copilot' },
    provider: { label: 'GitHub Copilot', signInCommand: 'copilot login' },
  }));
  assert.match(idle, /copilot login/);
  assert.doesNotMatch(idle, /Claude/);
});

test('a signed-out subscription account points at the settings, not at the CLI (TODO #330)', () => {
  setLocale('en');
  const idle = renderToStaticMarkup(React.createElement(AccountUsageStatus, {
    view: { kind: 'disconnected', backend: 'claude@k3f9a2b1c0' },
  }));
  assert.match(idle, /Subscription accounts/);
  assert.doesNotMatch(idle, /\/login/);
});
