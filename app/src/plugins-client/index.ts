'use client';

/**
 * The client halves shipped with the app, in no particular order: what a
 * module puts on screen is ranked by the slot entry itself (`order`), never
 * by its position in this table.
 */

import type { BundledClientPlugin } from './types';
import { uiLayoutClient } from './ui-layout';
import { uiThemeClient } from './ui-theme';
import { vaultClient } from './vault';
import { companyClient } from './company';
import { agentsProjectsClient } from './agents-projects';
import { botsClient } from './bots';
import { coreAgentsClient } from './agents';
import { coreMissionsClient } from './missions';
import { projectsClient } from './projects';
import { kanbanClient } from './kanban';
import { todoOutcomesClient } from './todo-outcomes';
import { routinesClient } from './routines';
import { triggersClient } from './triggers';
import { memoryClient } from './memory';
import { dreamsClient } from './dreams';
import { mcpAppsClient } from './mcp-apps';
import { agentChatClient } from './agent-chat';
import { coreSettingsClient } from './settings';
import { coreSecretsClient } from './secrets-vault';
import { coreBackendsClient } from './backends';
import { corePluginsClient } from './plugins';
import { workflowsClient } from './workflows';
import { notificationsClient } from './notifications';
import { notificationSoundsClient } from './notification-sounds';
import { localDictationClient } from './local-dictation';
import { terminalWebClient } from './terminal-web';
import { filesWidgetClient } from './files-widget';
import { widgetCardIslandClient } from './widget-card-island';
import { browserEmbeddedClient } from './browser-embedded';
import { browserRecordingClient } from './browser-recording';
import { browserAnnotationsClient } from './browser-annotations';
import { uiDocumentsClient } from './ui-documents';
import { machinesClient } from './machines';
import { telemetryClient } from './telemetry';
import { updatesClient } from './updates';

export const BUNDLED_CLIENT_PLUGINS: readonly BundledClientPlugin[] = [
  uiThemeClient,
  uiLayoutClient,
  vaultClient,
  coreAgentsClient,
  agentsProjectsClient,
  botsClient,
  companyClient,
  coreMissionsClient,
  projectsClient,
  kanbanClient,
  todoOutcomesClient,
  triggersClient,
  routinesClient,
  memoryClient,
  dreamsClient,
  mcpAppsClient,
  agentChatClient,
  coreSettingsClient,
  coreSecretsClient,
  coreBackendsClient,
  corePluginsClient,
  workflowsClient,
  notificationsClient,
  notificationSoundsClient,
  localDictationClient,
  terminalWebClient,
  filesWidgetClient,
  browserEmbeddedClient,
  browserRecordingClient,
  browserAnnotationsClient,
  widgetCardIslandClient,
  uiDocumentsClient,
  machinesClient,
  telemetryClient,
  updatesClient,
];
