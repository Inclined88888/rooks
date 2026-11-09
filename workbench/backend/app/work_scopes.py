"""The work account's switches and the permissions each one asks for (design 0012, section 1.2). One table, read by
connect.py (what a sign-in asks for), work_suite.py (what is on), the Work apps page and the terminal's /work (the same
words everywhere).

The first work sign-in asks only who the person is. Turning a switch on starts a fresh sign-in that asks only for that
switch's permissions (Microsoft's dynamic consent; Google's include_granted_scopes). Reading files and changing them
are separate switches, so files can be read without write permission ever being asked for.

`admin` lists the permissions a company administrator must approve even when people may approve apps themselves,
from Microsoft Graph's permissions reference (delegated permissions, "Admin consent required: Yes") as known when this
was built. It was not checked against a live tenant: a company can also require an administrator for every permission,
which the sign-in reports and the switch then shows as "Waiting for your IT team".
"""

from __future__ import annotations

IDENTITY = {
    "microsoft": ["openid", "email", "profile", "offline_access", "User.Read"],
    "google": ["openid", "email", "profile"],
}

# id, label, what it allows (per suite), Microsoft Graph delegated permissions, Google scopes, Microsoft permissions an
# administrator must approve, and whether the switch changes things outside (those always ask first)
FEATURES: list[dict] = [
    {"id": "mail", "label": "Mail", "asks_first": False,
     "says": {"microsoft": "Rooks can read your Outlook mail and save drafts. Sending always asks you first.",
              "google": "Rooks can read your Gmail and save drafts. Sending always asks you first."},
     "microsoft": ["Mail.ReadWrite", "Mail.Send"],
     "google": ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"]},
    {"id": "calendar", "label": "Calendar", "asks_first": False,
     "says": {"microsoft": "Rooks can see your Outlook calendar. Adding an event asks you first.",
              "google": "Rooks can see your Google Calendar. Adding an event asks you first."},
     "microsoft": ["Calendars.ReadWrite"], "google": ["https://www.googleapis.com/auth/calendar.events"]},
    {"id": "files_read", "label": "Files: read", "asks_first": False,
     "says": {"microsoft": "Rooks can find and read files in your OneDrive and the SharePoint sites you use.",
              "google": "Rooks can find and read files in your Google Drive and shared drives."},
     "microsoft": ["Files.Read.All", "Sites.Read.All"], "google": ["https://www.googleapis.com/auth/drive.readonly"]},
    {"id": "files_change", "label": "Files: change", "asks_first": True,
     "says": {"microsoft": "Rooks can upload, share and edit files in OneDrive and SharePoint.",
              "google": "Rooks can upload, share and edit files in Google Drive, Docs and Sheets."},
     "microsoft": ["Files.ReadWrite.All"],
     "google": ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/documents",
                "https://www.googleapis.com/auth/spreadsheets"]},
    {"id": "chats_read", "label": "Chats: read", "asks_first": False,
     "says": {"microsoft": "Rooks can read your Teams chats and the channels you are in.",
              "google": "Rooks can read your Google Chat spaces and messages."},
     "microsoft": ["Chat.Read", "Team.ReadBasic.All", "Channel.ReadBasic.All", "ChannelMessage.Read.All"],
     "google": ["https://www.googleapis.com/auth/chat.spaces.readonly", "https://www.googleapis.com/auth/chat.messages.readonly"]},
    {"id": "chats_post", "label": "Chats: post", "asks_first": True,
     "says": {"microsoft": "Rooks can post in your Teams chats and channels.",
              "google": "Rooks can post in your Google Chat spaces."},
     "microsoft": ["ChatMessage.Send", "ChannelMessage.Send"], "google": ["https://www.googleapis.com/auth/chat.messages.create"]},
    {"id": "transcripts", "label": "Meeting transcripts", "asks_first": False,
     "says": {"microsoft": "Rooks can bring the transcript of a Teams meeting you were in into Meetings.",
              "google": "Rooks can bring the transcript of a Meet call you were in into Meetings."},
     "microsoft": ["OnlineMeetings.Read", "OnlineMeetingTranscript.Read.All"],
     "google": ["https://www.googleapis.com/auth/meetings.space.readonly", "https://www.googleapis.com/auth/drive.readonly"]},
    {"id": "tasks", "label": "Tasks", "asks_first": True,
     "says": {"microsoft": "Rooks can show your Planner and To Do tasks with the rest, and change them.",
              "google": "Rooks can show your Google Tasks with the rest, and change them."},
     "microsoft": ["Tasks.ReadWrite"], "google": ["https://www.googleapis.com/auth/tasks"]},
]
BY_ID = {f["id"]: f for f in FEATURES}
ADMIN = {"microsoft": {"ChannelMessage.Read.All", "OnlineMeetingTranscript.Read.All"}, "google": set()}

# Why each permission is asked for, for the note a person sends to their IT team
WHY = {
    "Mail.ReadWrite": "read mail and save drafts", "Mail.Send": "send mail the person approved",
    "Calendars.ReadWrite": "read the calendar and add events the person approved",
    "Files.Read.All": "read files the person can open in OneDrive and SharePoint",
    "Sites.Read.All": "list the SharePoint sites and libraries the person can open",
    "Files.ReadWrite.All": "upload, share and edit files, each time only after the person says yes",
    "Chat.Read": "read the person's Teams chats", "Team.ReadBasic.All": "list the teams the person is in",
    "Channel.ReadBasic.All": "list the channels of those teams",
    "ChannelMessage.Read.All": "read messages in the channels the person is in",
    "ChatMessage.Send": "post in a chat, each time only after the person says yes",
    "ChannelMessage.Send": "post in a channel, each time only after the person says yes",
    "OnlineMeetings.Read": "find the Teams meetings the person was in",
    "OnlineMeetingTranscript.Read.All": "read the transcripts of those meetings",
    "Tasks.ReadWrite": "read the person's Planner and To Do tasks and change them after the person says yes",
}


def scopes(provider: str, feature: str) -> list[str]:
    return list(BY_ID[feature][provider])


def short(scope: str) -> str:
    """Microsoft answers with full addresses (https://graph.microsoft.com/Files.Read.All); compare by the name."""
    return scope.rsplit("/", 1)[-1] if scope.startswith("https://graph.microsoft.com/") else scope


def has(provider: str, feature: str, granted: set[str]) -> bool:
    g = {short(s) for s in granted}
    need = set(BY_ID[feature][provider])
    if provider == "microsoft" and feature == "mail":  # older accounts allowed Mail.Read only: reading still works
        return bool(g & {"Mail.ReadWrite", "Mail.Read"})
    return need <= g
