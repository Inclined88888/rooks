// @ts-check
/**
 * The models Pi can run for this user, read from `pi --list-models`: Pi prints the models of every
 * provider it holds a sign-in or a key for, and exits WITHOUT opening a session (verified on 1.4.0,
 * where the ACP probe of `pi-acp` left an empty session behind each time).
 *
 * The output is a text table, not JSON (there is no JSON form of it in 1.4.0):
 *
 *   provider  model   context  max-out  thinking  images
 *   mock      mock-a  100K     4.1K     no        no
 *
 * Columns are found by name in the header, and a model is named `provider/model`, the form Pi's
 * `--model` and `set_model` take.
 *
 * @typedef {import('@timon-ai/sdk/provider').DiscoveredModel} DiscoveredModel
 * @typedef {import('@timon-ai/sdk/provider').ProfileRuntime} ProfileRuntime
 * @typedef {import('@timon-ai/sdk/provider').ProviderBinary} ProviderBinary
 */

/** The thinking levels offered for a model Pi marks `thinking: yes` (Pi clamps a level the model lacks). */
export const PI_REASONING_LEVELS = Object.freeze(['low', 'medium', 'high']);

const LIST_TIMEOUT_MS = 20_000;

/**
 * @param {string} output what `pi --list-models` printed
 * @returns {DiscoveredModel[] | null} null when the output is not the table (the list cannot be told)
 */
export function parsePiModelList(output) {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const headerAt = lines.findIndex((line) => /^provider\s+model\b/i.test(line));
  if (headerAt < 0) return null;
  const header = lines[headerAt].toLowerCase().split(/\s+/);
  const providerCol = header.indexOf('provider');
  const modelCol = header.indexOf('model');
  const thinkingCol = header.indexOf('thinking');
  /** @type {DiscoveredModel[]} */
  const models = [];
  const seen = new Set();
  for (const line of lines.slice(headerAt + 1)) {
    const cells = line.split(/\s+/);
    const provider = cells[providerCol];
    const model = cells[modelCol];
    if (!provider || !model) continue;
    const slug = `${provider}/${model}`;
    if (seen.has(slug)) continue;
    seen.add(slug);
    models.push(thinkingCol >= 0 && cells[thinkingCol]?.toLowerCase() === 'yes'
      ? { slug, supportedReasoningLevels: [...PI_REASONING_LEVELS] }
      : { slug });
  }
  return models;
}

/**
 * `ModelsStrategy.discover`: rejects when Pi cannot tell (not installed, an error, a table it no
 * longer prints), never answers a guess.
 * @param {ProviderBinary} binary `ctx.provider.binary`
 * @param {string} name the binary's declared name
 * @param {ProfileRuntime} profile
 * @returns {Promise<DiscoveredModel[]>}
 */
export async function discoverPiModels(binary, name, profile) {
  const res = await binary.probe(name, ['--list-models'], { env: profile.env, timeoutMs: LIST_TIMEOUT_MS });
  if (res.timedOut) throw new Error('`pi --list-models` did not answer in time');
  if (res.code !== 0) throw new Error(`\`pi --list-models\` failed (exit ${res.code})`);
  const models = parsePiModelList(res.stdout);
  if (models === null) {
    // A Pi with no model configured says so instead of printing an empty table: that is an answer.
    if (/no models/i.test(`${res.stdout}\n${res.stderr}`)) return [];
    throw new Error('`pi --list-models` printed no model table');
  }
  return models;
}
