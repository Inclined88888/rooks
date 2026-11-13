/**
 * french-ok: the accented letter below is a mojibake sample, not French text
 * Windows consoles decode what Node writes (UTF-8) with their OEM code page
 * (437/850) unless the user ran `chcp 65001`: "·" prints as "┬╖", "é" as "├⌐"
 * (TIM-0114, PowerShell 5). Forcing the code page from here would change the
 * user's terminal for good, so the CLI writes plain ASCII to an interactive
 * Windows console instead. Pipes and files keep UTF-8 untouched, and
 * `ROOKS_CLI_UNICODE=1` opts out for a console known to be UTF-8.
 */

const SYMBOLS = new Map([
  ['→', '->'], ['←', '<-'], ['↔', '<->'], ['·', '-'], ['•', '*'], ['—', '-'], ['–', '-'], ['…', '...'],
  ['“', '"'], ['”', '"'], ['‘', "'"], ['’', "'"], ['«', '"'], ['»', '"'], ['×', 'x'], // french-ok: guillemets the table folds to ASCII
  ['✓', 'ok'], ['✔', 'ok'], ['✗', 'x'], ['✘', 'x'], ['⚠', '!'], [' ', ' '],
]);
const SYMBOL_RE = new RegExp(`[${[...SYMBOLS.keys()].join('')}]`, 'g');
const NON_ASCII = /[^\x00-\x7f]/;
const COMBINING_MARKS = /[̀-ͯ]/g;

/** Symbols get their ASCII look-alike, accented letters lose the accent;
 *  anything else (CJK, emoji) is left alone rather than turned into "?". */
export function toConsoleAscii(text) {
  if (!NON_ASCII.test(text)) return text;
  return text.replace(SYMBOL_RE, (c) => SYMBOLS.get(c)).normalize('NFD').replace(COMBINING_MARKS, '').normalize('NFC');
}

/** Wraps `write` of every interactive stream on Windows; returns whether it did. */
export function installConsoleAscii({ platform = process.platform, env = process.env, streams = [process.stdout, process.stderr] } = {}) {
  if (platform !== 'win32' || env.ROOKS_CLI_UNICODE === '1') return false;
  let installed = false;
  for (const stream of streams) {
    if (!stream || !stream.isTTY) continue;
    const write = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => write(typeof chunk === 'string' ? toConsoleAscii(chunk) : chunk, ...rest);
    installed = true;
  }
  return installed;
}
