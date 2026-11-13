/**
 * Imported for its side effect by the tests that switch language: every
 * language of `src/locales/` is registered, so `setLocale('fr')` applies at
 * once. The app never imports it.
 */
import { useSourceLocales } from './i18n-sources';

useSourceLocales();
