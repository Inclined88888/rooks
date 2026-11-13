/**
 * A list of tools written over several lines is ordinary YAML: read as empty,
 * the skill silently pre-authorises fewer tools than its author wrote. Both
 * parsers read it, and whatever a parser reads, the write guard refuses.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseSkillFrontmatter, readSkillsAllowedTools, upsertSkill } = await import('./skills.js');
const { parseFrontmatter } = await import('./skill-registry.js');
const { declaresAllowedTools } = await import('./users/skills-mcp-guard.js');

const fm = (front: string, eol = '\n') => `---\nname: x\n${front}\ndescription: after\n---\n\n# x\n`.replaceAll('\n', eol);
const read = (content: string) => ({
  spawn: parseSkillFrontmatter(content).allowed_tools,
  registry: parseFrontmatter(content).fm.allowed_tools,
});
const expectBoth = (content: string, tools: string[]) => {
  assert.deepEqual(read(content), { spawn: tools, registry: tools }, JSON.stringify(content));
};

const MULTILINE: Array<[string, string, string[]]> = [
  ['JSON array', '[\n  "Bash(git add:*)",\n  "Read"\n]', ['Bash(git add:*)', 'Read']],
  ['YAML flow list', '[\n  Bash(git add:*),\n  Read\n]', ['Bash(git add:*)', 'Read']],
  ['trailing comma', '[\n  Bash,\n  Read,\n]', ['Bash', 'Read']],
  ['several entries per line', '[\n  Bash, Read,\n  Edit\n]', ['Bash', 'Read', 'Edit']],
  ['entries and bracket at column 0', '[\nBash,\nRead\n]', ['Bash', 'Read']],
  ['first entry on the opening line', '[Bash,\n  Read]', ['Bash', 'Read']],
  ['blank line and comments', '[ # the tools\n  Bash, # git\n\n  # reading\n  Read\n] # done', ['Bash', 'Read']],
  ['bracket inside an entry', '[\n  Bash(ls [ab]*),\n  "Read(x])"\n]', ['Bash(ls [ab]*)', 'Read(x])']],
  ['list on the next line', '\n  [Bash, Read]', ['Bash', 'Read']],
  ['folded scalar', '>\n  Bash(git add:*)\n  Read', ['Bash(git add:*)', 'Read']],
  ['literal scalar, chomped', '|-\n  Bash\n\n  Read', ['Bash', 'Read']],
  ['plain scalar continued', 'Bash(git add:*)\n  Read', ['Bash(git add:*)', 'Read']],
  ['plain scalar on the next line', '\n  Bash Read', ['Bash', 'Read']],
];

for (const [name, value, tools] of MULTILINE) {
  test(`multi-line tools, ${name}: both spellings, both parsers, LF and CRLF`, () => {
    for (const key of ['allowed-tools', 'allowed_tools']) {
      expectBoth(fm(`${key}: ${value}`), tools);
      expectBoth(fm(`${key}: ${value}`, '\r\n'), tools);
    }
  });
}

test('the forms that already worked keep working, comments now ignored', () => {
  expectBoth(fm('allowed-tools: ["Bash(git:*)", "Read"]'), ['Bash(git:*)', 'Read']);
  expectBoth(fm('allowed-tools: [Bash, Read]'), ['Bash', 'Read']);
  expectBoth(fm('allowed-tools: Bash(git add:*) Read'), ['Bash(git add:*)', 'Read']);
  expectBoth(fm('allowed-tools:\n  - "Bash(git:*)"\n  - Read'), ['Bash(git:*)', 'Read']);
  expectBoth(fm('allowed-tools:\n- Bash\n- Read'), ['Bash', 'Read']);
  expectBoth(fm('allowed-tools:\n  - Bash\n\n  - Read'), ['Bash', 'Read']);
  expectBoth(fm('allowed-tools: [Bash, Read] # the tools'), ['Bash', 'Read']);
  expectBoth(fm('allowed-tools: Bash Read # the tools'), ['Bash', 'Read']);
  expectBoth(fm('allowed-tools:\n  # the tools\n  - Bash # git\n  - Read'), ['Bash', 'Read']);
  expectBoth(fm('allowed-tools: Bash(echo #:*) Read'), ['Bash(echo #:*)', 'Read']);
  expectBoth(fm('allowed-tools:\n  - "Bash(echo # x:*)"'), ['Bash(echo # x:*)']);
});

test('the keys after a multi-line list are still read', () => {
  const content = fm('allowed-tools: [\n  Bash,\n  Read\n]\nmodel: opus');
  assert.equal(parseFrontmatter(content).fm.model, 'opus');
  assert.equal(parseFrontmatter(content).fm.description, 'after');
  const folded = parseFrontmatter(fm('allowed-tools: >\n  Bash\n  Read\nmodel: opus')).fm;
  assert.deepEqual([folded.allowed_tools, folded.model], [['Bash', 'Read'], 'opus']);
});

test('both spellings over several lines: their union', () => {
  expectBoth(fm('allowed-tools: [\n  Read,\n  Edit\n]\nallowed_tools: [\n  Edit,\n  Bash\n]'), ['Read', 'Edit', 'Bash']);
});

test('a CRLF front matter reads every key in the registry too', () => {
  const { fm: parsed } = parseFrontmatter('---\r\nname: x\r\ndescription: d\r\nallowed-tools: Bash Read\r\nmodel: opus\r\n---\r\n# x\r\n');
  assert.deepEqual(parsed, { name: 'x', description: 'd', allowed_tools: ['Bash', 'Read'], model: 'opus' });
});

test('a list that never closes pre-authorises nothing', () => {
  const unclosed = [
    'allowed-tools: [Bash',
    'allowed-tools: [\n  Bash,\n  Read',
    // The next key is not an entry, even when its value would close the list.
    'allowed-tools: [\n  Bash\nmodel: opus]',
    'allowed-tools: [\n  Bash\nother: [Read]',
    // Text after the closing bracket: the list is not what it looks like.
    'allowed-tools: [Bash] Read',
    'allowed-tools: [\n  Bash\n] Read',
  ];
  for (const front of unclosed) {
    assert.deepEqual(parseSkillFrontmatter(fm(front)).allowed_tools ?? [], [], front);
    assert.deepEqual(parseFrontmatter(fm(front)).fm.allowed_tools ?? [], [], front);
  }
});

test('a list never reads past the front matter, into the body of the skill', () => {
  const content = '---\nname: x\nallowed-tools: [\n  Bash\n---\n\n]\n\n# x\n';
  assert.deepEqual(parseSkillFrontmatter(content).allowed_tools ?? [], []);
  assert.deepEqual(parseFrontmatter(content).fm.allowed_tools ?? [], []);
});

test('the tools of a multi-line list reach the spawn', () => {
  upsertSkill('multi-line-tools', fm('allowed-tools: [\n  "Bash(git:*)",\n  Read\n]'));
  assert.deepEqual(readSkillsAllowedTools(['multi-line-tools']), ['Bash(git:*)', 'Read']);
});

test('the guard refuses every multi-line shape a parser reads', () => {
  for (const [name, value] of MULTILINE) {
    for (const key of ['allowed-tools', 'allowed_tools', 'Allowed-Tools']) {
      assert.equal(declaresAllowedTools(fm(`${key}: ${value}`)), true, `${key} ${name}`);
      assert.equal(declaresAllowedTools(fm(`${key}: ${value}`, '\r\n')), true, `${key} ${name} CRLF`);
    }
  }
});

test('quotes inside an entry stay part of its pattern', () => {
  const pattern = `Bash(git log --format='%h':*)`;
  expectBoth(fm(`allowed-tools: ${pattern} Read`), [pattern, 'Read']);
  expectBoth(fm(`allowed-tools: [\n  ${pattern},\n  Read\n]`), [pattern, 'Read']);
  expectBoth(fm(`allowed-tools:\n  - ${pattern}\n  - Read`), [pattern, 'Read']);
});
