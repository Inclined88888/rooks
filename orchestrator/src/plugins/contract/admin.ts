/** Public plugin types, extracted from the host implementations (TODO #512). */
/**
 * `code` of a refusal:
 *  - `invalid`: the input is wrong, nothing was written;
 *  - `not_found`: the target does not exist OR the caller may not see it;
 *  - `conflict`: the name is already taken, or the change would orphan something;
 *  - `forbidden`: the rule of the facade, not of the manifest or the account, refuses;
 *  - `unavailable`: the module behind the facade is off or has nothing to answer with.
 */
export type PluginAdminErrorCode = 'invalid' | 'not_found' | 'conflict' | 'forbidden' | 'unavailable';
