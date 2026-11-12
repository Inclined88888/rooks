#!/usr/bin/env node
/**
 * Generates the ROOKS Web Push VAPID key pair ONCE.
 *
 *   node orchestrator/scripts/generate-vapid.mjs
 *
 * Paste the output into the `.env` at the root of the repo (never into git —
 * `.env` is already ignored). Regenerating the keys invalidates ALL existing
 * subscriptions: every device will have to subscribe again from /notifications.
 */
import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.log(`# ROOKS Web Push — paste into <repo>/.env
ROOKS_VAPID_PUBLIC_KEY=${publicKey}
ROOKS_VAPID_PRIVATE_KEY=${privateKey}
ROOKS_VAPID_SUBJECT=mailto:you@example.com`);
