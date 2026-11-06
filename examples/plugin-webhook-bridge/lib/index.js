import { createHmac, timingSafeEqual } from 'node:crypto';

/** @typedef {import('@timon-ai/sdk').PluginJsonObject} JsonObject */
/** @typedef {import('@timon-ai/sdk').PluginWorkflowTriggerContext} TriggerContext */

/** @param {unknown} value @returns {JsonObject} */
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return /** @type {JsonObject} */ (value);
}
/** @param {unknown} value @param {number} [max] */
function text(value, max = 128) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid text');
  return value;
}
const textSchema = {
  /** @param {unknown} value */
  parse(value) { return { text: text(object(value).text, 64_000) }; } };
const topicSchema = {
  /** @param {unknown} value */
  parse(value) { return { topic: text(object(value).topic) }; } };
const emptySchema = {
  /** @param {unknown} value */
  parse(value) { object(value); return {}; } };

/** The only Timon dependency is the public PluginContext. @param {import('@timon-ai/sdk').PluginContext} ctx */
export function apply(ctx) {
  const transportId = `${ctx.id}:signed-webhook@1`;
  const eventId = `${ctx.id}:message.received@1`;
  /** @type {Set<TriggerContext>} */
  const signals = new Set();

  ctx.businessEvents.register({ name: 'message.received', version: 1, payloadSchema: textSchema });
  ctx.workflows.registerExecutor({
    name: 'uppercase', version: 1, configSchema: emptySchema, outputPorts: ['out'],
    execute: ({ input }) => ({ output: { text: textSchema.parse(input).text.toUpperCase() }, port: 'out' }),
  });
  ctx.workflows.registerTrigger({
    name: 'signal', version: 1, configSchema: topicSchema,
    start(context) { signals.add(context); return () => { signals.delete(context); }; },
  });
  ctx.transports.register({
    name: 'signed-webhook', version: 1, timeoutMs: 15_000,
    configSchema: {
      parse(value) {
        const config = object(value);
        const url = new URL(text(config.replyUrl, 2048));
        const localHttp = ctx.config.allowLocalHttp === true && url.protocol === 'http:'
          && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
        if ((!localHttp && url.protocol !== 'https:') || url.username || url.password || url.hash || url.search) {
          throw new Error('Expected an HTTPS callback URL without credentials, query or fragment');
        }
        return { room: text(config.room), replyUrl: url.href };
      },
    },
    async receive(context, request) {
      const stamp = request.headers['x-timon-timestamp'] ?? '';
      const signature = request.headers['x-timon-signature'] ?? '';
      if (!/^[0-9]{10}$/.test(stamp) || Math.abs(Date.now() / 1000 - Number(stamp)) > 300 || !/^[a-f0-9]{64}$/.test(signature)) {
        throw new Error('Invalid signature envelope');
      }
      const signing = await context.secret('signing');
      if (!signing || signing.length < 24) throw new Error('Signing secret unavailable');
      const expected = createHmac('sha256', signing).update(`${stamp}.`).update(request.body).digest();
      if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new Error('Invalid signature');
      const message = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.body)));
      if (message.room !== context.connection.config.room) throw new Error('Room not allowed');
      // Inbound URLs, credentials and identity fields never select the callback.
      return { externalId: text(message.id), text: text(message.text, 64_000), replyContext: { room: text(message.room) } };
    },
    async send(context, reply) {
      const room = text(object(reply.replyContext).room);
      if (room !== context.connection.config.room) throw new Error('Reply room differs from the accepted connection');
      const points = Array.from(reply.text);
      const count = Math.max(1, Math.ceil(points.length / 2000));
      const next = reply.checkpoint === null ? 0 : object(reply.checkpoint).next;
      if (typeof next !== 'number' || !Number.isInteger(next) || next < 0 || next > count) throw new Error('Invalid checkpoint');
      if (next === count) return { done: true, checkpoint: { next } };
      const bearer = await context.secret('callback');
      if (!bearer || !ctx.fetch) throw new Error('Callback credential or HTTP capability unavailable');
      const response = await ctx.fetch(text(context.connection.config.replyUrl, 2048), {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([context.signal, AbortSignal.timeout(10_000)]),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}`, 'idempotency-key': `${reply.idempotencyKey}:${next}` },
        body: JSON.stringify({ room, text: points.slice(next * 2000, (next + 1) * 2000).join(''), fragment: next, total: count }),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error('Callback refused the fragment');
      return { done: next + 1 === count, checkpoint: { next: next + 1 } };
    },
  });

  const router = ctx.router();
  // Express 4 needs explicit promise forwarding. Responses never echo provider errors.
  router.get('/connections', (_req, res, next) => {
    ctx.connections.list().then((connections) => res.json({ connections })).catch(next);
  });
  router.post('/connections', (req, res, next) => {
    (async () => {
      const input = object(req.body);
      const connection = await ctx.connections.create({
        transport: transportId, agent: text(input.agent), config: object(input.config),
        secretRefs: { signing: text(object(input.secretRefs).signing), callback: text(object(input.secretRefs).callback) },
      });
      res.status(201).json({ connection, inboundPath: await ctx.connections.inboundPath(connection.id) });
    })().catch(next);
  });
  router.patch('/connections/:id', (req, res, next) => {
    ctx.connections.update(req.params.id, req.body).then((connection) => res.json({ connection })).catch(next);
  });
  router.post('/events', (req, res, next) => {
    (async () => {
      const input = object(req.body);
      const runs = await ctx.businessEvents.publish(eventId, { id: text(input.id), payload: textSchema.parse(input) });
      res.status(202).json({ runs });
    })().catch(next);
  });
  router.post('/signals', (req, res, next) => {
    (async () => {
      ctx.assertPermission('events:publish');
      const owner = ctx.user()?.id;
      if (!owner) { res.status(401).json({ error: 'User authentication required' }); return; }
      const input = object(req.body);
      const topic = text(input.topic);
      const event = { id: text(input.id), payload: textSchema.parse(input) };
      for (const target of signals) {
        if (target.identity.ownerUserId === owner && object(target.config).topic === topic) await target.emit(event);
      }
      res.status(202).json({ ok: true });
    })().catch(next);
  });
  /** @type {import('express').ErrorRequestHandler} */
  const errors = (_error, _req, res, _next) => { return res.status(400).json({ error: 'Integration operation refused; check permissions and input' }); };
  router.use(errors);
}
