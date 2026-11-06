#!/usr/bin/env node
/**
 * Generates the TIMON Web Push VAPID key pair ONCE.
 *
 *   node orchestrator/scripts/generate-vapid.mjs
 *
 * Paste the output into the `.env` at the root of the repo (never into git —
 * `.env` is already ignored). Regenerating the keys invalidates ALL existing
 * subscriptions: every device will have to subscribe again from /notifications.
 */
import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.log(`# TIMON Web Push — paste into <repo>/.env
TIMON_VAPID_PUBLIC_KEY=${publicKey}
TIMON_VAPID_PRIVATE_KEY=${privateKey}
TIMON_VAPID_SUBJECT=mailto:you@example.com`);
