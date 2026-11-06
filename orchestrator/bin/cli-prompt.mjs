/** The `code` of what the hidden prompt rejects with when the person backs out. */
export const PROMPT_CANCELLED = 'ERR_PROMPT_CANCELLED';

// An arrow key arrives as ESC plus printable characters: dropping the ESC alone
// would leave `[A` in the key, unseen.
const ESCAPE_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|O[@-~])?/g;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * A terminal gets a hidden prompt: a pasted token must not stay on screen or
 * in the scrollback. Anything else is read from the pipe.
 *
 * Raw mode leaves the keys to this function, which follows a hidden prompt on a
 * normal terminal (getpass, readline): Enter submits, Ctrl-C cancels, Ctrl-D
 * cancels on an empty line and does nothing on a line in progress, so a
 * half-typed key is never submitted. Any other control character is dropped.
 * Cancelling rejects with `PROMPT_CANCELLED`.
 */
export function readHiddenLine(prompt, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    // Raw before the prompt shows: a key pressed as soon as it is up is neither echoed nor a signal.
    input.setRawMode(true);
    output.write(prompt);
    let value = '';
    input.setEncoding('utf8');
    input.resume();
    const done = (fn) => { input.setRawMode(false); input.pause(); input.removeListener('data', onData); output.write('\n'); fn(); };
    const cancel = () => done(() => reject(Object.assign(new Error('cancelled'), { code: PROMPT_CANCELLED })));
    const onData = (chunk) => {
      for (const ch of chunk.replace(ESCAPE_SEQUENCE, '')) {
        if (ch === '\r' || ch === '\n') return done(() => resolve(value));
        if (ch === '\u0003') return cancel();
        if (ch === '\u0004') {
          if (!value) return cancel();
        } else if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (!CONTROL_CHARACTER.test(ch)) value += ch;
      }
    };
    input.on('data', onData);
  });
}
