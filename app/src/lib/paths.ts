import { homedir } from 'node:os';
import { join } from 'node:path';

export const ROOKS_HOME = process.env.ROOKS_HOME ?? join(homedir(), '.rooks');

// Channels
export const CHANNELS_DIR = join(ROOKS_HOME, 'channels');
export const MISSION_MAP_PATH = join(ROOKS_HOME, 'channel-missions.json');

// Remote (bearer-auth API)
export const REMOTE_DB_PATH = join(ROOKS_HOME, 'remote.db');
export const REMOTE_KEY_PATH = join(ROOKS_HOME, 'remote-key');
export const TOKEN_TTL_SECONDS = Number(process.env.ROOKS_TOKEN_TTL ?? 60 * 60 * 24);

// Cross-service
export const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL ?? 'http://localhost:3000';
export const APP_URL = process.env.APP_URL ?? 'http://localhost:3100';
