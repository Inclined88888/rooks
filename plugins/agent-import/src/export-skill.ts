/**
 * The `timon-export` skill, the text another agent tool (Hermes, Grok Bot…)
 * runs to write an archive this import reads. Embedded in the host bundle at
 * build time (`--loader:.md=text`): an installed package ships `lib/` only, so
 * a file read from disk next to it would be missing.
 */
import text from '../skills/timon-export/SKILL.md';

export const EXPORT_SKILL_NAME = 'timon-export';
/** The file name an agent tool expects for a skill. */
export const EXPORT_SKILL_FILE = 'SKILL.md';
export const EXPORT_SKILL: string = text;
