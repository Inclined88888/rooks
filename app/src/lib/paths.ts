import { homedir } from 'node:os';
import { join } from 'node:path';

export const TIMON_HOME = process.env.TIMON_HOME ?? join(homedir(), '.timon');

// Channels
export const CHANNELS_DIR = join(TIMON_HOME, 'channels');
export const MISSION_MAP_PATH = join(TIMON_HOME, 'channel-missions.json');

// Remote (bearer-auth API)
export const REMOTE_DB_PATH = join(TIMON_HOME, 'remote.db');
export const REMOTE_KEY_PATH = join(TIMON_HOME, 'remote-key');
export const TOKEN_TTL_SECONDS = Number(process.env.TIMON_TOKEN_TTL ?? 60 * 60 * 24);

// Cross-service
export const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL ?? 'http://localhost:3000';
export const APP_URL = process.env.APP_URL ?? 'http://localhost:3100';
