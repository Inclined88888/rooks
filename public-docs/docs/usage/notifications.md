---
title: Notifications
sidebar_position: 4.7
---

## Where notifications show up

Agents and Timon itself raise three kinds of notification: **Need you** (an agent waits for an answer or a permission), **Alerts** and **Reports**. Each one names the agent that raised it, or Timon for its own.

- **The bell**, in the top bar, opens a menu of the recent notifications. Its badge counts the active ones. Use the check mark on a row to mark it as read, or **Mark all as read** for the whole list.
- **The Notifications widget** is the same bell, moved: rest the pointer on the bell for two seconds to show its grip, then drag it out of the top bar. In a sidebar it stays a button, its list opening next to it on click; in the cockpit or a chat column it shows the list as a card. Drag it back to the top bar to get the icon on the line again.
- **The archive** (`/notifications`, or **See all notifications** at the bottom of the menu) keeps everything, read or not.

Marking a notification as read removes it from the menu and from the badge; it stays in the archive.

A **Need you** notification also clears by itself once the action it asked for is done: answering a permission or a question, running or refusing a command request, applying or ignoring a proposal, deciding the last Dreaming track, or approving the plugin whose card asked for it. After a restart of Timon, permission cards that can no longer be answered are removed too. A **Need you** notification an agent sends itself clears when you write in that agent's conversation, or when the task it names is done; one that is tied to neither clears after 24 hours, and none stays longer than 7 days. Reports and alerts stay until you mark them as read.

The **Copy** button of a notification (in the bell's menu, the Notifications widget, the notification column and the archive) puts its title and its whole text on the clipboard, to paste an error message elsewhere. It works over plain HTTP on a local network too.

## Choose what the bell's menu lists

On the archive page, the **Bell menu** block sets what the bell's menu and the Notifications widget list:

- **Kinds shown**: tick the kinds to list. At least one stays ticked.
- **Show at most**: how many notifications the menu lists, from 5 to 100 (15 by default). The menu scrolls when the list is taller than the screen.

The settings apply at once in the tab you change them in, and are saved on your account: other open tabs and every browser you sign in from show the same list once they reload.

**Need you only**, the switch under the title of the bell's menu and of the Notifications widget, lists only the notifications waiting for you to act, and the badge then counts only those. Switch it off to get back the kinds you ticked. It is saved on your account with the settings above.

When some kinds are hidden, the bell's badge only counts the kinds shown, and **Mark all as read** only marks those kinds: hidden notifications stay active until you show them again or read them in the notification center. The archive and the notification center always list every kind.

## Push notifications

The button at the top of the archive page turns on push (system) notifications for the device you are on. The browser asks for permission the first time; each device is switched on separately.

## Sounds

Timon can play a short sound when:

- **Task started**: one of your Kanban tasks begins running (off at first, see below);
- **Task done**: a Kanban task is marked done;
- **Task blocked or failed**: a Kanban task stops — blocked, failed, or out of quota (Timon closes a failed task as blocked, so both share this sound, distinct from the "done" one by default);
- **Approval needed**: an agent waits on you, with a permission card or a question card;
- **Mission finished**: an agent ends its turn in a conversation you started (the missions run for Kanban tasks have their own done and blocked sounds, and do not play this one).

Set them in **Settings › Interface › Notifications**, under **Sounds**:

- a switch per event turns its sound on or off (all on at first, except **Task started**);
- the list next to it picks one of six built-in sounds, and the play button lets you hear it;
- the folder button next to it chooses **your own sound file** for that event (see below);
- **Volume** applies to every event; at 0 the sounds are muted.

**Task started** sounds once per task: not again when Timon retries it or you restart it, and not for the review, merge and documentation steps Timon adds after a task. You only hear the tasks of your own account. Its row has a second switch, **Also show a notification**, which shows a short notice with the task's title on screen — on its own, even with the sound off. It is off at first too.

The settings are saved on your account, like the bell's.

### Your own sound

Choose a file with the folder button next to an event: it then appears in that event's list under its file name, and the cross removes it. Each event keeps its own file.

- **Formats:** the ones your browser or the desktop app can play — WAV, MP3, OGG, FLAC and M4A/AAC in practice (Safari is the strictest: it does not play OGG).
- **Limits:** up to 1 MiB and 10 seconds. A larger or longer file, or one that cannot be played, is refused with a message.
- The file is stored on your account, so it follows you to every device. Only you can hear it or download it back.

Good to know:

- **Click once in Timon after opening it.** Browsers and the desktop app only allow a page to make sound after you have interacted with it. Until then that window stays silent.
- **One window plays the sound.** With several tabs or windows of Timon open in the same browser (or the same desktop app), a single one plays it, preferably the one on screen. A tab in the background still plays when no Timon tab is on screen. The desktop app and a browser are kept apart, though: with both open, both play.
- **Many tasks closing or starting at once give one sound** (and one notice), not one per task.
- You only hear about the tasks and agents your account can see.
