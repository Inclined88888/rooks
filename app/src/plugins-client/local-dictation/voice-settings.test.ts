import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { DEFAULT_VOICE_SETTINGS, readVoiceSettings, writeVoiceSettings } from './voice-settings';

test('a stored value this build cannot read is the default, one field at a time', () => {
  assert.deepEqual(readVoiceSettings(null), DEFAULT_VOICE_SETTINGS);
  assert.deepEqual(readVoiceSettings({ language: 'fr' }), DEFAULT_VOICE_SETTINGS);
  assert.deepEqual(readVoiceSettings({ v: 2, language: 'fr' }), DEFAULT_VOICE_SETTINGS);
  assert.deepEqual(readVoiceSettings({
    v: 1, language: 'fr-FR', interim: 'instant',
    models: { fr: 'canary-180m-flash-int8', '../x': 'canary', en: '../../etc', auto: 7, de: 'Acme' },
  }), { language: null, interim: 'auto', models: { fr: 'canary-180m-flash-int8' } });
});

test('a valid value reads back as written', () => {
  const settings = { language: 'auto', interim: 'final-only' as const, models: { auto: 'parakeet-tdt-0.6b-v3-int8', fr: 'acme.fr-large' } };
  assert.deepEqual(writeVoiceSettings(settings), { v: 1, ...settings });
  assert.deepEqual(readVoiceSettings(writeVoiceSettings(settings)), settings);
});
