// A stand-in for `pi --mode rpc` that replays one of the recordings beside it (argv[2], a name
// without `.jsonl`): it writes what Pi wrote, waits at each `_sent` marker for the command the
// client sent there (answering with the client's own id), and exits when stdin closes, as Pi does.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const records = readFileSync(join(here, `${process.argv[2]}.jsonl`), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const ids = new Map();
let at = 0;

function flush() {
  while (at < records.length && !('_sent' in records[at])) {
    const record = { ...records[at++] };
    if (record.type === 'response' && typeof record.id === 'string') record.id = ids.get(record.id) ?? record.id;
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }
}

let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  for (let nl = pending.indexOf('\n'); nl !== -1; nl = pending.indexOf('\n')) {
    const command = JSON.parse(pending.slice(0, nl));
    pending = pending.slice(nl + 1);
    const marker = records[at]?._sent;
    if (!marker || marker.type !== command.type) {
      process.stderr.write(`fake-pi: unexpected command ${command.type}\n`);
      process.exit(3);
    }
    ids.set(marker.id, command.id);
    at += 1;
    flush();
  }
});
process.stdin.on('end', () => process.exit(0));
flush();
