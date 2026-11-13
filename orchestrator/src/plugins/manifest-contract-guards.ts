/**
 * The manifest types the SDK publishes (`plugins/contract/manifest.ts`) are
 * written by hand; the ones the daemon validates with are derived from its zod
 * schema (`plugins/manifest.ts`). These guards prove at compilation that both
 * are identical (TODO #512, volet 4): a field added to the schema, a kind or a
 * webhook format added to its list, or an API version bumped on one side only
 * turns `tsc` red. Kept apart so `manifest.ts` keeps no knowledge of the SDK.
 */
import type { Assert, Equals } from '../type-equality.js';
import type {
  PLUGIN_API_VERSION, PluginDictationDecl, PluginDictationEngineDecl, PluginHttpDecl, PluginHttpHostDecl, PluginKind,
  PluginManifest, PluginMascotDecl, PluginProviderDecl, PluginSecretDecl, PluginSetting, PluginWebhookDecl,
} from './manifest.js';
import type {
  PLUGIN_API_VERSION as CONTRACT_PLUGIN_API_VERSION,
  PluginDictationDecl as ContractPluginDictationDecl,
  PluginDictationEngineDecl as ContractPluginDictationEngineDecl,
  PluginHttpDecl as ContractPluginHttpDecl,
  PluginHttpHostDecl as ContractPluginHttpHostDecl,
  PluginKind as ContractPluginKind,
  PluginManifest as ContractPluginManifest,
  PluginMascotDecl as ContractPluginMascotDecl,
  PluginProviderDecl as ContractPluginProviderDecl,
  PluginSecretDecl as ContractPluginSecretDecl,
  PluginSetting as ContractPluginSetting,
  PluginWebhookDecl as ContractPluginWebhookDecl,
} from './contract/manifest.js';

type _ApiVersionMatchesContract = Assert<Equals<typeof PLUGIN_API_VERSION, typeof CONTRACT_PLUGIN_API_VERSION>>;
type _PluginKindMatchesContract = Assert<Equals<PluginKind, ContractPluginKind>>;
type _PluginSettingMatchesContract = Assert<Equals<PluginSetting, ContractPluginSetting>>;
type _PluginWebhookDeclMatchesContract = Assert<Equals<PluginWebhookDecl, ContractPluginWebhookDecl>>;
type _PluginProviderDeclMatchesContract = Assert<Equals<PluginProviderDecl, ContractPluginProviderDecl>>;
type _PluginDictationEngineDeclMatchesContract = Assert<Equals<PluginDictationEngineDecl, ContractPluginDictationEngineDecl>>;
type _PluginDictationDeclMatchesContract = Assert<Equals<PluginDictationDecl, ContractPluginDictationDecl>>;
type _PluginSecretDeclMatchesContract = Assert<Equals<PluginSecretDecl, ContractPluginSecretDecl>>;
type _PluginHttpHostDeclMatchesContract = Assert<Equals<PluginHttpHostDecl, ContractPluginHttpHostDecl>>;
type _PluginMascotDeclMatchesContract = Assert<Equals<PluginMascotDecl, ContractPluginMascotDecl>>;
type _PluginHttpDeclMatchesContract = Assert<Equals<PluginHttpDecl, ContractPluginHttpDecl>>;
/** The daemon's `Omit<…> & { kind }` as one object: the contract spells the manifest out flat (TODO #578). */
type Flatten<T> = { [K in keyof T]: T[K] };
type _PluginManifestMatchesContract = Assert<Equals<Flatten<PluginManifest>, ContractPluginManifest>>;
