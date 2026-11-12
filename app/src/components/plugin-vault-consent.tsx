'use client';

/**
 * "Secrets and network" on the install sheet, by name (TODO #599, step 4):
 * the secrets and hosts the manifest names, where each stands on this daemon,
 * and a box for what can be consented to here.
 *
 * Only a `grantable` secret has a box; the others say why not and where to go.
 * A host already open to this plugin starts ticked, because the daemon
 * replaces the plugin's host list with what is ticked: unticking closes it.
 * The author's `why` is shown as written — it cannot be translated.
 */
import Link from 'next/link';
import { hostTickable, secretCreateHref, secretTickable, type PluginVault, type PluginVaultSecret, type VaultTicks } from '@/lib/plugin-install';
import { t } from '@/lib/i18n';

const BOX = 'mt-0.5 shrink-0';
// Keeps the text of a line without a box aligned with the ticked ones.
const NO_BOX = 'mt-0.5 inline-block w-[13px] shrink-0';

export function PluginVaultConsent({
  vault,
  pluginId,
  ticks,
  busy,
  onTick,
}: {
  vault: PluginVault;
  pluginId: string;
  ticks: VaultTicks;
  busy: boolean;
  onTick: (kind: 'secrets' | 'hosts', key: string, value: boolean) => void;
}): React.ReactElement {
  return (
    <div className="space-y-3 text-[12px] leading-relaxed" data-testid="vault-named">
      <p className="m-0 font-medium">{t('pluginsPage.install.vault.title')}</p>

      {vault.secrets.length > 0 && (
        <div className="space-y-1.5">
          <p className="m-0 text-muted-foreground">{t('pluginsPage.install.vault.secretsLead')}</p>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {vault.secrets.map((secret) => (
              <li key={secret.name} data-secret={secret.name}>
                {secretTickable(secret)
                  ? (
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className={BOX}
                        checked={ticks.secrets[secret.name] === true}
                        disabled={busy}
                        onChange={(e) => onTick('secrets', secret.name, e.target.checked)}
                      />
                      <SecretText secret={secret} />
                    </label>
                  )
                  : (
                    <div className="flex items-start gap-2">
                      <span className={NO_BOX} aria-hidden />
                      <div className="min-w-0">
                        <SecretText secret={secret} />
                        <SecretState secret={secret} pluginId={pluginId} />
                      </div>
                    </div>
                  )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {vault.hosts.length > 0 && (
        <div className="space-y-1.5">
          <p className="m-0 text-muted-foreground">{t('pluginsPage.install.vault.hostsLead')}</p>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {vault.hosts.map((host) => (
              <li key={host.host} data-host={host.host}>
                {hostTickable(host)
                  ? (
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className={BOX}
                        checked={ticks.hosts[host.host] === true}
                        disabled={busy}
                        onChange={(e) => onTick('hosts', host.host, e.target.checked)}
                      />
                      <span className="min-w-0">
                        <span className="break-all font-medium">{host.host}</span>
                        {host.why && <span className="block text-muted-foreground">{host.why}</span>}
                        {host.allowedBy === 'plugin' && (
                          <span className="block text-muted-foreground">{t('pluginsPage.install.vault.hostOwn')}</span>
                        )}
                      </span>
                    </label>
                  )
                  : (
                    <div className="flex items-start gap-2">
                      <span className={NO_BOX} aria-hidden />
                      <span className="min-w-0">
                        <span className="break-all font-medium">{host.host}</span>
                        {host.why && <span className="block text-muted-foreground">{host.why}</span>}
                        <span className="block text-muted-foreground">{t('pluginsPage.install.vault.hostGlobal')}</span>
                      </span>
                    </div>
                  )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SecretText({ secret }: { secret: PluginVaultSecret }): React.ReactElement {
  return (
    <span className="min-w-0">
      <span className="break-all font-medium">{secret.name}</span>
      {' · '}
      <span className="text-muted-foreground">{t(`pluginsPage.install.vault.mode.${secret.mode}`)}</span>
      {secret.why && <span className="block text-muted-foreground">{secret.why}</span>}
    </span>
  );
}

function SecretState({ secret, pluginId }: { secret: PluginVaultSecret; pluginId: string }): React.ReactElement | null {
  const href = secretCreateHref(secret.name, pluginId);
  switch (secret.state) {
    case 'granted':
      return <p className="m-0 text-emerald-700 dark:text-emerald-400">{t('pluginsPage.install.vault.state.granted')}</p>;
    case 'missing':
      return (
        <p className="m-0 text-amber-800 dark:text-amber-300" data-state="missing">
          {t(secret.otherMode ? 'pluginsPage.install.vault.state.otherMode' : 'pluginsPage.install.vault.state.missing')}
          {' '}
          <Link href={href} className="font-medium underline underline-offset-2">{t('pluginsPage.install.vault.create')}</Link>
        </p>
      );
    case 'ambiguous':
      return (
        <p className="m-0 text-amber-800 dark:text-amber-300">
          {t('pluginsPage.install.vault.state.ambiguous')}
          {' '}
          <Link href={href} className="font-medium underline underline-offset-2">{t('pluginsPage.install.vault.choose')}</Link>
        </p>
      );
    case 'vault-off':
      return <p className="m-0 text-muted-foreground">{t('pluginsPage.install.vault.state.vault-off')}</p>;
    default:
      return null;
  }
}
