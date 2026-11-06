/** What the embedded browser presents to sites, derived from the Chromium Electron ships. */

export interface BrowserUserAgentMetadata {
  brands: Array<{ brand: string; version: string }>;
  fullVersionList: Array<{ brand: string; version: string }>;
  fullVersion: string;
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
}

const FALLBACK_CHROME = '130.0.0.0';

/** Drops the `Electron/x` and `<AppName>/x` tokens: identity providers refuse or loop on an embedded shell. */
export function desktopUserAgent(raw: string): string {
  return raw
    .replace(/\sElectron\/\S+/g, '')
    .replace(/(\(KHTML, like Gecko\))\s+\S+\/\S+(?=\s+Chrome\/)/, '$1');
}

export function chromeVersion(userAgent: string): string {
  return userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? FALLBACK_CHROME;
}

export function mobileUserAgent(chrome: string): string {
  return `Mozilla/5.0 (Linux; Android 14; Timon) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Mobile Safari/537.36`;
}

/**
 * Client hints (`Sec-CH-UA`, `navigator.userAgentData`) are sent separately from the UA string and
 * would otherwise still name Electron, so a login page that checks them keeps rejecting the browser.
 */
export function userAgentMetadata(
  chrome: string, mobile: boolean, platform: NodeJS.Platform, systemVersion: string,
): BrowserUserAgentMetadata {
  const major = chrome.split('.')[0] || '130';
  const desktopPlatform = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux';
  return {
    brands: [
      { brand: 'Chromium', version: major },
      { brand: 'Google Chrome', version: major },
      { brand: 'Not_A Brand', version: '24' },
    ],
    fullVersionList: [
      { brand: 'Chromium', version: chrome },
      { brand: 'Google Chrome', version: chrome },
      { brand: 'Not_A Brand', version: '24.0.0.0' },
    ],
    fullVersion: chrome,
    platform: mobile ? 'Android' : desktopPlatform,
    platformVersion: mobile ? '14.0.0' : systemVersion,
    architecture: mobile ? '' : 'x86',
    model: '', mobile,
  };
}

/** `Sec-CH-UA` header value for a brand list, e.g. `"Chromium";v="130", "Google Chrome";v="130"`. */
export function clientHintBrands(list: Array<{ brand: string; version: string }>): string {
  return list.map((entry) => `"${entry.brand}";v="${entry.version}"`).join(', ');
}
