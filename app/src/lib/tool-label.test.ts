import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Plug } from 'lucide-react';
import { toolDisplayTitle, toolLabel } from './tool-label';
import { ToolCall } from '../components/chat/tool-call';

test('tool labels prefer metadata and humanize MCP names without a catalog', () => {
  assert.equal(toolLabel('mcp__timon__agent_recv_messages'), 'Timon · Agent Receive Messages');
  assert.equal(toolLabel('mcp__chrome-devtools__list_pages'), 'Chrome Devtools · List Pages');
  assert.equal(toolLabel('mcp__custom_server__readNote'), 'Custom Server · Read Note');
  assert.equal(toolLabel('Read'), 'Read');
  assert.equal(toolLabel('mcp__timon__agent_recv_messages', 'Inbox'), 'Inbox');
  assert.equal(toolDisplayTitle({ annotations: { title: 'Inbox' } }), 'Inbox');
  assert.equal(toolDisplayTitle({ title: 'Messages', annotations: { title: 'Inbox' } }), 'Messages');
  assert.equal(toolDisplayTitle({ title: 4 }), undefined);
});

test('closed tool summary contains neither slug nor arguments but preserves errors and details', () => {
  const html = renderToStaticMarkup(React.createElement(ToolCall, {
    name: 'mcp__timon__agent_recv_messages', icon: Plug,
    headHtml: '<pre>mcp__timon__agent_recv_messages {"from_agent":"librarian"}</pre>',
    result: { html: '<pre>Connection refused</pre>', isError: true },
  }));
  const summary = /<summary[^>]*>(.*?)<\/summary>/.exec(html)![1]!;
  assert.match(summary, /Timon · Agent Receive Messages/);
  assert.match(summary, /error/);
  assert.doesNotMatch(summary, /mcp__|from_agent|librarian/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
  assert.match(html, /from_agent/);
  assert.match(html, /Connection refused/);
});
