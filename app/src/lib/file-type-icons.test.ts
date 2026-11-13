import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { fileTypeFor } from './file-type-icons';
import { iconFor } from './file-icons';

test('known families get their own colour, by extension, case-insensitively or by name', () => {
  assert.equal(fileTypeFor('report.PDF')?.color, '#e5383b');
  assert.equal(fileTypeFor('a.docx')?.color, '#2f6fe4');
  assert.equal(fileTypeFor('a.xlsx')?.color, '#1f9d55');
  assert.equal(fileTypeFor('index.php')?.color, '#8a6fd1');
  assert.equal(fileTypeFor('app.js')?.color, '#e6b800');
  assert.equal(fileTypeFor('Dockerfile.prod')?.label, 'DOCK');
  assert.equal(fileTypeFor('.env.local')?.label, 'ENV');
  assert.equal(fileTypeFor('mystery.zzz'), null);
});

test('the Files tree gets the same component for the same family, so rows do not remount', () => {
  assert.equal(iconFor('a.pdf', 'file').Icon, iconFor('b.pdf', 'file').Icon);
  assert.notEqual(iconFor('a.pdf', 'file').Icon, iconFor('a.php', 'file').Icon);
});
