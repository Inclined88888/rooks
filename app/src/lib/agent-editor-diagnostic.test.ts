import assert from 'node:assert/strict';
import test from 'node:test';
import { startAgentEditorDiagnostic } from './agent-editor-diagnostic';

test('editor diagnostic is opt-in, observes blocked clicks, redacts content and cleans up', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="editor"><input data-agent-editor-name value="private-name"></div><div id="blocker">private-text</div>', {
    url: 'http://localhost', pretendToBeVisual: true,
  });
  const doc = dom.window.document;
  const root = doc.getElementById('editor')!;
  const input = root.querySelector('input')!;
  const blocker = doc.getElementById('blocker')!;
  const logs: string[] = [];
  const original = console.info;
  console.info = (_prefix: string, value: string) => { logs.push(value); };
  Object.defineProperty(doc, 'elementsFromPoint', { value: () => [blocker, input] });
  const paint = () => new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
  let stop = () => {};
  try {
    stop = startAgentEditorDiagnostic(root);
    input.click();
    await paint();
    assert.equal(logs.length, 0, 'production is silent without explicit opt-in');
    stop();
    dom.window.sessionStorage.setItem('rooks:diagnostic:agent-editor', '1');
    stop = startAgentEditorDiagnostic(root);
    blocker.addEventListener('click', (event) => event.preventDefault());
    blocker.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    input.focus();
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'secret-key', bubbles: true }));
    await paint();
    const records = logs.map((line) => JSON.parse(line));
    const click = records.find((record) => record.event === 'click' && record.phase === 'after-dispatch');
    assert.equal(click.prevented, true);
    assert.equal(click.target.inEditor, false);
    assert.equal(click.nameHit[0].node, click.target.node, 'hit testing reveals the covering element');
    assert.ok(records.some((record) => record.active?.nameField));
    assert.doesNotMatch(logs.join(''), /private-name|private-text|secret-key|blocker|localhost/);
    stop();
    const count = logs.length;
    input.click();
    await paint();
    assert.equal(logs.length, count, 'listeners and pending frames are removed');
    stop = startAgentEditorDiagnostic(root);
    assert.notEqual(JSON.parse(logs.at(-1)!).mount, records[0].mount, 'remounts are distinguishable');
    for (let i = 0; i < 200; i++) input.click();
    await paint();
    assert.ok(logs.length <= count + 150, 'a session cannot flood the console');
  } finally {
    stop();
    console.info = original;
    dom.window.close();
  }
});
