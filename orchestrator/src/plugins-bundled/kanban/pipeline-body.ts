/**
 * Bodies of `POST`/`PUT /api/pipelines` and `POST /api/pipelines/:id/run`
 * (TODO #787). Strict: a misspelt step field (`depends_on` for `deps_on`)
 * used to be stored and ignored, so the run opened every step at once.
 *
 * Types only: step ids, unknown deps, cycles and task types keep the
 * messages of `validateDefinition` (`pipelines.ts`).
 */
import { z } from 'zod';
import { parseStrictBody } from './task-update-body.js';

const names = z.array(z.string().max(512)).max(256);

const PIPELINE_STEP_FIELDS = {
  id: z.string().max(64),
  agent: z.string().max(255),
  type: z.string().max(64).optional(),
  prompt: z.string(),
  deps_on: z.array(z.string().max(64)).max(256).optional(),
  priority: z.number().int().optional(),
  extra_skills: names.optional(),
  extra_mcp_servers: names.optional(),
  extra_allowed_tools: names.optional(),
  model_override: z.string().max(255).optional(),
  permission_mode_override: z.string().max(255).optional(),
} as const;

const PipelineDefinitionSchema = z.object({
  steps: z.array(z.object(PIPELINE_STEP_FIELDS).strict()).max(256),
}).strict();

const PIPELINE_FIELDS = {
  name: z.string().min(1).max(255),
  description: z.string().max(4000).nullable().optional(),
  definition: PipelineDefinitionSchema,
} as const;

const PipelineCreateSchema = z.object(PIPELINE_FIELDS).strict();
const PipelineUpdateSchema = z.object(PIPELINE_FIELDS).partial().strict();
const PIPELINE_RUN_FIELDS = { input: z.record(z.string(), z.unknown()).optional() } as const;
const PipelineRunSchema = z.object(PIPELINE_RUN_FIELDS).strict();

export function parsePipelineCreateBody(raw: unknown) {
  return parseStrictBody(PipelineCreateSchema, Object.keys(PIPELINE_FIELDS), raw);
}

export function parsePipelineUpdateBody(raw: unknown) {
  return parseStrictBody(PipelineUpdateSchema, Object.keys(PIPELINE_FIELDS), raw);
}

export function parsePipelineRunBody(raw: unknown) {
  return parseStrictBody(PipelineRunSchema, Object.keys(PIPELINE_RUN_FIELDS), raw);
}
