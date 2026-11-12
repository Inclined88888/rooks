---
title: Hermes Gateway
sidebar_position: 12.5
---

The **Hermes Gateway** plugin lets the Hermes agents you run on your own Hermes gateway answer in Rooks like any other agent: in the chat, in missions and in Kanban tasks other than code. The gateway can run on another machine. Each Rooks account connects its own gateway with its own key; Rooks never shares one account's gateway with another.

This is different from the [Hermes](./hermes.md) backend, which starts `hermes-acp` on the machine that runs Rooks. Use the gateway when Hermes lives elsewhere, or when it should keep its own tools, memory and models.

## Prepare your Hermes gateway

1. **Hermes 0.21.0 or later**; **0.21.6 or later is recommended**. From 0.21.6 on, an answer whose stream is cut (a network blip) resumes where it stopped. With 0.21.0 to 0.21.5, Rooks still gets the final answer, but the text stops appearing live after a cut.
2. **The API server needs `aiohttp`.** It is not one of Hermes' core dependencies: without it, `hermes gateway` starts *without* its API server, and nothing answers on its port. Install the `messaging` extra of Hermes (or `aiohttp` itself) in Hermes' environment.
3. **Enable the API server** in `~/.hermes/.env`:

   ```bash
   API_SERVER_ENABLED=true
   API_SERVER_KEY=<a key of at least 16 characters>
   ```

   Hermes refuses to start its API server with a shorter key. Then start the gateway with `hermes gateway`; it listens on `http://127.0.0.1:8642` by default.
4. **Named profiles** are reached under `/p/<profile>/`, each with its **own** key, set in that profile's own `.env` (`profiles/<profile>/.env`). The default profile's key does not open another profile.

## Reach it from Rooks

The gateway listens on its own machine's loopback by default. If Rooks runs elsewhere, make the gateway reachable without exposing it to the internet:

- **Tailscale** (recommended): serve the gateway's port on your tailnet (`tailscale serve`), and use its `https://<machine>.<tailnet>.ts.net` address, or its Tailscale IP.
- **A reverse proxy with HTTPS** that forwards the `Authorization` header.

Rooks accepts plain `http://` only for an address on your own machine, your local network or Tailscale.

## Connect it

1. Turn the plugin on: it ships with Rooks, switched off. An administrator enables **Hermes Gateway** from the **Plugins** page, or runs `rooks plugin enable hermes-gateway` (see [Plugins](./plugins-gallery.md)).
2. In **Settings → Secrets → Connections**, choose **Add a connection** and pick **Hermes Gateway**:
   - the gateway's address (`https://…`, or `http://…` for a local or Tailscale address, with *This service is on my machine or local network* ticked);
   - **Hermes profile**: leave it empty for the default profile, or give the profile name;
   - **API server key**: the `API_SERVER_KEY` of that profile.

   Add one connection per Hermes profile you want in Rooks, and per gateway if you run several.
3. An administrator approves the address (in the same pane). **Test** then checks that the gateway answers, that the key is accepted, and that Hermes is recent enough.
4. Open **Settings → Hermes Gateway**: each gateway shows its state (connected and Hermes version, waiting for approval, turned off, unreachable). **Add my Hermes agents to Rooks** adds one Rooks agent per connected profile, named `hermes.<profile>` (several gateways: see below). Your Hermes agents stay on your gateway: nothing is created or changed there, Rooks only gets an entry point to each profile.

Adding them needs an administrator account: only an administrator may put a new agent on a backend whose tool approvals do not go through Rooks's own permission levels. Once added, anyone may talk to them, and each person reaches **their own** gateway with **their own** key. Someone with no Hermes connection is told so in the chat.

## Several gateways

You can connect as many Hermes gateways as you run (a home server and a work machine, say): add one connection per gateway, and per profile you want from each.

- A profile that only **one** of your gateways serves gets the agent `hermes.<profile>`, as above.
- A profile that **several** of your gateways serve (typically `default` on each) gets one agent per gateway, named after the connection's label: `hermes.home.default`, `hermes.work.default`. If that name is already taken, the start of the connection's identifier is added (`hermes.home-6f1c2a9e.default`).

An agent tied to one gateway serves **your account only**: anyone else who talks to it is told that the agent is tied to a connection they do not have. If you delete the connection, the agent says the same; click **Add my Hermes agents to Rooks** again after adding a gateway, or after changing a connection's profile. An agent `hermes.<profile>` you already had keeps working as before: it reaches the first of your connected gateways that serves its profile, and each other person reaches their own.

**Settings → Hermes Gateway** lists, under each gateway, the Rooks agents that reach it.

## Change a gateway

To change a gateway's address, profile, key or *local network* setting, choose **Edit** on its connection in **Settings → Secrets → Connections**. The form opens with its current values, except the key: leave **API server key** empty to keep the current one, or type the new key to replace it. A new address (another host or port) or a change of *local network* waits for an administrator's approval again, and the form says so before you save; a new profile or path on the same address does not.

## What works

- Replies stream into the chat, tool calls appear with a short preview of what they did, and sub-agents Hermes starts show as their own cards.
- When Hermes asks to run a risky command, an **Allow / Deny** card appears. **Allow** lets that one command through; **Deny** blocks it and Hermes carries on without it. On an autonomous mission with nobody to answer, the card ends in a refusal after the usual delay.
- **Stop** ends the current answer on the gateway too; the conversation goes on.
- The conversation lives in Hermes: a mission that resumes reopens the same Hermes session, and Rooks asks Hermes to keep a separate memory for each Rooks account.
- **Rooks restarts** (an update, a reboot) do not lose an answer in progress: the mission picks the Hermes run up again, and an approval card that was open is shown again.
- **The gateway restarts**: Hermes ends the answer in progress. The chat says so, shows what Hermes had already written, and you send your message again to continue.
- When the gateway is busy (too many answers at once), your message waits for a free slot.
- **Skills** checked on a Hermes agent are sent to the gateway whole, with every prompt: Hermes cannot read them from Rooks on demand. Only the `SKILL.md` goes, not the files beside it.

## What does not work

- **Closing a Kanban task.** A task other than code runs, and Hermes' answer stays in its mission, but a Hermes agent cannot mark the task done or write its report: Rooks closes it as done once the mission has been idle for a while, with a note that the agent reported nothing.
- **Code tasks.** A Hermes agent works on the gateway's machine, not in Rooks's folder: a Kanban task of type `code` or `merge` assigned to it is blocked with the reason.
- **Attached files.** Hermes would drop them without a word, so Rooks refuses the message instead. Images are not sent either: the chat says so.
- **Rooks's tools.** Kanban, messages to other agents and memory are not available to Hermes agents: Hermes loads its tools from its own configuration, and has no way to receive a per-mission access to Rooks.
- **"Allow for the session" or "always allow".** The card allows or refuses one command at a time.
- **Missions with no account behind them**, such as a Kanban task nobody owns or a routine: there is no account, hence no gateway, to run them on.
- **The model** is chosen in Hermes, per profile, not in Rooks.
