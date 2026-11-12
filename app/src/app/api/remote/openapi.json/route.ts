import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const proto = req.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? url.host;
  const baseUrl = `${proto}://${host}`;

  const spec = {
    openapi: '3.1.0',
    info: {
      title: 'Rooks — Remote Control',
      version: '0.1.0',
      description:
        'Spawn and manage Claude Code missions remotely. Bearer-auth via short-lived local-signed tokens.',
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: {
        Mission: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            agent: { type: 'string' },
            status: { type: 'string', enum: ['running', 'completed', 'failed'] },
            running: { type: 'boolean' },
            started_at: { type: 'integer' },
            ended_at: { type: ['integer', 'null'] },
            exit_code: { type: ['integer', 'null'] },
          },
          required: ['id', 'agent', 'status', 'running', 'started_at'],
        },
        Error: { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      '/api/remote/missions': {
        post: {
          summary: 'Spawn a new mission',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['agent', 'input'],
                  properties: {
                    agent: { type: 'string', description: 'Agent name (folder in ~/.rooks/agents/)' },
                    input: { type: 'string', description: 'Mission text to send to the agent' },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Mission spawned',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { mission_id: { type: 'string' } },
                    required: ['mission_id'],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '429': { description: 'Rate limited' },
          },
        },
      },
      '/api/remote/missions/{id}': {
        get: {
          summary: 'Get mission status',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Mission' } } } },
            '404': { description: 'Not found' },
          },
        },
        delete: {
          summary: 'Kill a running mission',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'Killed' },
            '404': { description: 'No running mission with that id' },
          },
        },
      },
      '/api/remote/missions/{id}/output': {
        get: {
          summary: 'Get final assistant output (markdown)',
          description:
            'Concatenated assistant text blocks from the mission stream. Returns text/markdown by default, or JSON with the same field if Accept: application/json is sent.',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'OK',
              content: {
                'text/markdown': { schema: { type: 'string' } },
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      mission_id: { type: 'string' },
                      status: { type: 'string' },
                      running: { type: 'boolean' },
                      output_markdown: { type: 'string' },
                    },
                  },
                },
              },
            },
            '404': { description: 'Not found' },
          },
        },
      },
    },
  };

  return NextResponse.json(spec);
}
