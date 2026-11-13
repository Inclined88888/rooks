/**
 * `allowed-tools` is the Agent Skills standard, `allowed_tools` the historical
 * Rooks spelling. A standard skill imported as is must keep its pre-authorised
 * tools, and the write guard must see every key a parser reads: a spelling or
 * a block boundary the guard does not share is a way round it.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseSkillFrontmatter, splitToolList } = await import('./skills.js');
const { parseFrontmatter } = await import('./skill-registry.js');
const { declaresAllowedTools } = await import('./users/skills-mcp-guard.js');

const fm = (front: string) => `---\nname: x\n${front}\n---\n\n# x\n`;

test('both spellings are read, inline JSON and YAML block alike', () => {
  for (const key of ['allowed_tools', 'allowed-tools']) {
    assert.deepEqual(parseSkillFrontmatter(fm(`${key}: ["Bash(rooks:*)", "Read"]`)).allowed_tools, ['Bash(rooks:*)', 'Read'], key);
    assert.deepEqual(parseSkillFrontmatter(fm(`${key}:\n  - "Bash(git:*)"\n  - Read`)).allowed_tools, ['Bash(git:*)', 'Read'], key);
  }
});

test('the standard string forms: space-delimited, comma-delimited, YAML flow list', () => {
  assert.deepEqual(parseSkillFrontmatter(fm('allowed-tools: Bash(git add:*) Read')).allowed_tools, ['Bash(git add:*)', 'Read']);
  assert.deepEqual(parseSkillFrontmatter(fm('allowed-tools: Bash(git add:*), Bash(git status:*)')).allowed_tools, ['Bash(git add:*)', 'Bash(git status:*)']);
  assert.deepEqual(parseSkillFrontmatter(fm('allowed-tools: [Bash, Read]')).allowed_tools, ['Bash', 'Read']);
  assert.deepEqual(splitToolList(`"Bash(a b)" 'Read' , Edit`), ['Bash(a b)', 'Read', 'Edit']);
});

test('both spellings present: their union, deduplicated, standard first', () => {
  const both = fm('allowed-tools: Read Bash(git:*)\nallowed_tools:\n  - "Bash(git:*)"\n  - Edit');
  assert.deepEqual(parseSkillFrontmatter(both).allowed_tools, ['Read', 'Bash(git:*)', 'Edit']);
  assert.deepEqual(parseFrontmatter(both).fm.allowed_tools, ['Read', 'Bash(git:*)', 'Edit']);
});

test('CRLF files and a missing key', () => {
  assert.deepEqual(parseSkillFrontmatter('---\r\nallowed-tools:\r\n  - Read\r\n---\r\n# x\r\n').allowed_tools, ['Read']);
  assert.deepEqual(parseSkillFrontmatter(fm('description: no tools')), {});
  assert.deepEqual(parseSkillFrontmatter('# no front matter\nallowed-tools: Bash\n'), {});
});

test('the Claude Code skill registry reads the same lists', () => {
  assert.deepEqual(parseFrontmatter(fm('allowed-tools: Bash(git add:*) Read')).fm.allowed_tools, ['Bash(git add:*)', 'Read']);
  assert.deepEqual(parseFrontmatter(fm('allowed_tools: ["Bash"]')).fm.allowed_tools, ['Bash']);
});

test('the guard sees every key a parser reads', () => {
  const shapes = [
    fm('allowed_tools: ["Bash"]'),
    fm('allowed-tools: ["Bash"]'),
    fm('allowed_tools:\n  - Bash'),
    fm('allowed-tools:\n  - Bash'),
    fm('allowed-tools: Bash Read'),
    fm('Allowed-Tools: Bash'),
    // A line that only starts with `---` does not close the block for skills.ts.
    '---\nname: x\n----\nallowed-tools: Bash\n---\n# x\n',
    '---\nname: x\n---x\nallowed_tools: Bash\n---\n# x\n',
    // An empty first block: both parsers open on the second `---`.
    '---\n\n---\nallowed-tools: Bash\n---\n# x\n',
    // Unclosed: read it all.
    '---\nallowed-tools: Bash\n',
  ];
  for (const content of shapes) {
    const parsed = parseSkillFrontmatter(content).allowed_tools ?? parseFrontmatter(content).fm.allowed_tools ?? [];
    assert.equal(declaresAllowedTools(content), true, JSON.stringify(content));
    if (parsed.length) assert.ok(parsed.includes('Bash'), JSON.stringify(content));
  }
});

test('the guard does not refuse a skill that only mentions the key in its body', () => {
  assert.equal(declaresAllowedTools('---\nname: x\n---\n\nallowed-tools: lists the tools\n'), false);
  assert.equal(declaresAllowedTools('# x\n\nallowed_tools: lists the tools\n'), false);
});
