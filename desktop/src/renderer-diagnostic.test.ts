import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { diagnosticUrl, startRendererDiagnostic } from './renderer-diagnostic.js';

class DebuggerFake extends EventEmitter {
  commands: string[] = [];
  attach(): void {}
  async sendCommand(method: string): Promise<unknown> {
    this.commands.push(method);
    return method === 'Debugger.getScriptSource' ? { scriptSource: '<html>private-secret</html>' } : {};
  }
  report(method: string, params: unknown): void { this.emit('message', {}, method, params); }
}

test('diagnostics observe failed dynamic scripts, runtime stacks and transport without logging contents', async () => {
  const debug = new DebuggerFake();
  const lines: string[] = [];
  startRendererDiagnostic(debug, (line) => lines.push(line));
  debug.report('Debugger.scriptFailedToParse', { scriptId: '42', url: '', length: 4267,
    stackTrace: { callFrames: [{ scriptId: '12', url: 'https://user:private-secret@localhost/_next/static/chunk.js?token=private-secret', lineNumber: 1, columnNumber: 7 }] } });
  debug.report('Runtime.exceptionThrown', { exceptionDetails: {
    scriptId: '42', lineNumber: 0, columnNumber: 4267,
    exception: { className: 'SyntaxError', description: 'private-secret' },
    stackTrace: { callFrames: [{ scriptId: '12', url: 'file:///private-secret/preload.cjs', lineNumber: 5 }] },
  } });
  debug.report('Network.responseReceived', { requestId: '1', type: 'Fetch', response: {
    url: 'https://localhost/api/invite/private-secret?token=private-secret', status: 204,
    mimeType: 'text/html', headers: { authorization: 'private-secret' },
  } });
  debug.report('Network.loadingFinished', { requestId: '1', encodedDataLength: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  const records = lines.map((line) => JSON.parse(line));
  assert.ok(debug.commands.includes('Debugger.getScriptSource'));
  assert.equal(records.find((r) => r.kind === 'failed-source').looksLikeHtml, true);
  assert.equal(records.find((r) => r.kind === 'exception').column, 4267);
  assert.equal(records.find((r) => r.kind === 'response').status, 204);
  assert.equal(records.find((r) => r.kind === 'response-finished').encodedBytes, 0);
  assert.ok(records.some((r) => r.kind === 'ready'));
  assert.ok(!lines.join('').includes('private-secret'));
});

test('diagnostic output is bounded and failures never escape', async () => {
  const debug = new DebuggerFake();
  const lines: string[] = [];
  startRendererDiagnostic(debug, (line) => lines.push(line));
  for (let i = 0; i < 6000; i++) debug.report('Runtime.exceptionThrown', {});
  assert.equal(lines.length, 5000);
  const unavailable = new DebuggerFake();
  unavailable.attach = () => { throw new Error('private-secret'); };
  startRendererDiagnostic(unavailable, (line) => lines.push(line));
  assert.match(lines.at(-1)!, /attach-failed/);
  assert.doesNotThrow(() => startRendererDiagnostic(unavailable, () => { throw new Error(); }));
  const rejected = new DebuggerFake();
  rejected.sendCommand = async () => { throw new Error('private-secret'); };
  startRendererDiagnostic(rejected, (line) => lines.push(line));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(lines.at(-1)!, /enable-failed/);
  assert.ok(!lines.join('').includes('private-secret'));
});

test('URLs omit inline source, local paths, query, fragments and credentials', () => {
  assert.equal(diagnosticUrl('data:text/javascript,private-secret'), '[data:]');
  assert.equal(diagnosticUrl('file:///private-secret'), '[local-script]');
  assert.equal(diagnosticUrl('https://user:pass@localhost/_next/static/a.js?token=x#secret'), 'https://localhost/_next/static/a.js');
});
