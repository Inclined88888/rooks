---
title: Teach an agent by recording a browser flow
sidebar_position: 3.2
---

Show an agent how to do something on a website once, and it learns to do it again. You record what you do in the [built-in browser](missions.md#the-built-in-browser), check the recorded steps, then press **Learn**: an agent turns the recording into a [skill](agents.md#skills) that replays the flow with its browser tools. Give that skill to an agent, and ask it to run the flow whenever you need, or on a schedule.

Recording works wherever the built-in browser runs: in the desktop app on Windows, macOS and Linux, and from a web browser or the installed web app on your phone while the desktop app is running. It is provided by the **Browser recording** plugin, on by default (**Settings → Plugins**); the Lite preset leaves it off.

## Record

1. Open the built-in browser of a project whose browser profile is yours.
2. Press **●** (**Record**) in the address bar. A **Recording · N steps** pill appears and counts your actions.
3. Go through the flow as you normally would: open the site, sign in, fill the form, click through the pages. Popups (a "Sign in with…" window) and new tabs are recorded too.
4. Press **Stop** on the pill. The recorded steps open for review.

While you record, agents cannot click or type in that browser: their actions are refused until you stop, so the recording only holds what you did. They can still read the page.

A recording also ends on its own after 30 minutes without any action, or when it reaches its step limit. The pill then shows **Recording ended**; press **Review** to open it.

Only the owner of the browser profile can record and review. Someone watching the same browser from another device sees the pill, but cannot start a recording; the owner can stop one from any device. If another of your devices holds the browser, click the page first to take it over.

## What is never recorded

- **Passwords, one-time codes and card details.** Timon never reads what you type in these fields. The step only says that a password, a code or card details were typed, as a masked placeholder.
- **Saved logins.** When you fill a login saved in the browser's Credentials, the step records that a saved login was used on that site, never the password.
- **Tokens in addresses.** Sign-in links and callbacks carry codes and tokens in their address (`?code=`, `?token=`, `#access_token=`…). These parts of the address are masked.
- **What a click shows.** Clicking a field does not record what the field contains.

Nothing is written to disk while you record: if you quit Timon in the middle, the recording is gone. A stopped recording is stored encrypted on this computer.

## Review

The review lists every step: **Go to**, **Click**, **Type**, **Press Enter**, **New tab**, **Switch tab**, **Close tab**, **Saved login**, and masked **Secret field** steps.

Steps in amber are marked **Possible secret**: a value that looks like an API key, an access token, a card number or a password typed into an ordinary field. For each one, choose:

- **Mask value**: the value is replaced by a placeholder, for good. A masked value cannot be shown again.
- **Keep as is**: the value is not a secret, keep it.
- **Delete**: remove the step.

**Learn** stays greyed out until every possible secret is settled.

You can also:

- **Make a parameter** of a typed value that changes each time (a search term, a date, an amount): the skill will ask for it instead of always typing what you typed.
- **Rename** a step or the recording, so the skill reads well.
- **Delete** a step you did by mistake.
- **Delete recording** when you no longer need it.

Look at the plain values one last time before you press Learn. **Nothing is sent to a model before Learn; after it, the agent reads the recording as you left it.** A secret you typed into an ordinary field and kept as is will reach the agent's conversation and its model provider, and stays in that conversation's history even after the recording is deleted.

## Learn

Press **Learn**, pick the agent, then press **Start learning**. The agent starts a mission that reads the recording once and writes a skill named `browser-…`. That mission can read the recording, create this one new skill, open the pages the recording visited (exactly those addresses) to check it, and ask you questions, and nothing else: it cannot change or delete any of your existing skills, start other missions or change your agents, whatever the recorded pages say. It also runs without a shell, cannot read or write files and gets none of your account's connectors, so only agents whose backend can run that way are offered (Claude, Codex, Copilot and the providers built on them, not Grok or the ACP agents); with none, Learn tells you so. The mission opens in a floating window, so you can follow it and answer its questions, such as whether a value is fixed or changes each time.

**Let the skill submit the final step without asking** is off by default: the skill then asks for your confirmation before it sends, orders or publishes anything. Turn it on only for a flow you are happy to see run to the end unattended.

When the mission is done, the review shows **Learned skill**:

- **Attach to *agent***: adds the skill this mission created to an agent that uses this browser profile. Nothing is attached until you click. If no agent uses this profile, attach the skill from the agent's settings (**Skills** tab). If the mission created no skill, the card says so; **Refresh** checks again.
- **Open the mission** shows what the agent did and wrote.

Once the skill is written, the recorded steps are deleted: the skill is what remains of the flow.

## Run the flow

Ask the agent in a chat ("run the browser-invoices skill for March"), or give it a Kanban task. To run it on a schedule, create a routine for that agent in **Triggers → Routines** (see [Triggers](triggers.md)).

The desktop app must be running on the computer that runs the built-in browser, and the browser must be signed in to the site: the skill uses the sessions and saved logins of the browser profile, never a password of its own. A saved login the skill needs is listed at the top of the skill; save it in the browser's Credentials first.

## Limits

- **One-time codes and card details need you.** The skill never stores them: it pauses and asks you to type them yourself in the shared browser, then carries on once you answer **Done**. A skill with such a pause needs someone in front of the screen and cannot run as an unattended routine.
- **Frames inside a page are not recorded.** Actions inside an embedded frame, such as a payment form or a captcha box, do not appear in the recording. Do these steps by hand when the skill runs, or describe them to the agent.
- **Sign-in in several pages.** A saved login is filled only on a page that has the password field. A sign-in that asks for the user name on one page and the password on the next may need you.
- **Websites change.** The skill describes what to look for rather than replaying exact positions, but a redesigned site can still break it. Record the flow again and learn it once more.
- **Retention.** A recording you do not learn is deleted after 7 days. Change this in **Settings → Access & network → Browser** (**Keep unlearned browser recordings**; 0 keeps recordings until you delete them).
- **One user's recordings.** Recordings belong to the owner of the browser profile. Other accounts, administrators included, cannot see them. Plugins can read them only with the **browser recordings** permissions, which you approve when you install the plugin (see [plugin permissions](../plugins/permissions.md)).
