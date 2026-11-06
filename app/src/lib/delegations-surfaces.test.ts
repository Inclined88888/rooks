/**
 * Les deux surfaces d'une même liste : elles doivent se taire d'une seule
 * voix, et ne jamais recopier le détail l'une de l'autre.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DelegationsBar } from '../components/chat/delegations-bar';
import type { Delegation } from '../hooks/use-delegations';

function delegation(over: Partial<Delegation> = {}): Delegation {
  return {
    id: 'child-1',
    agent_name: 'timon.coder',
    started_at: Date.now() - 90_000,
    running: true,
    turn_active: true,
    task_id: null,
    task_title: null,
    excerpt: 'refonte du composer',
    ...over,
  };
}

test('aucune délégation : le bandeau ne peint rien', () => {
  assert.equal(renderToStaticMarkup(React.createElement(DelegationsBar, { delegations: [] })), '');
});

test('le bandeau annonce le compte et nomme chaque agent une seule fois', () => {
  const html = renderToStaticMarkup(
    React.createElement(DelegationsBar, {
      delegations: [
        delegation(),
        delegation({ id: 'child-2' }),
        delegation({ id: 'child-3', agent_name: 'timon.reviewer' }),
      ],
    }),
  );
  assert.ok(html.includes('3 delegated mission(s) running'));
  assert.ok(html.includes('timon.coder, timon.reviewer'));
  // Sobriété : le brief appartient à la carte du rail, pas au fil.
  assert.ok(!html.includes('refonte du composer'));
});
