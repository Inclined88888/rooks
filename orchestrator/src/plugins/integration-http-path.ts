/** Only this exact POST bypasses daemon auth; the provider authenticates its raw body. */
export const INTEGRATION_INBOUND_PATH = /^\/api\/integrations\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/inbound\/?$/;
