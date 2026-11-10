# AI Workspace for VS Code

Ask your self-hosted AI Workspace from the editor. It is the same assistant as in the app: same memory, tools,
projects and approvals. Anything that sends or changes something outside your editor still waits for your OK in
the app; the extension shows a link when that happens.

## Set up

1. In AI Workspace, open **Assistant**, then **Terminal access**, and choose **Create token**.
2. In VS Code run **AI Workspace: Set terminal access token** and paste it. It is kept in VS Code's secret storage.
3. Nothing else for the app on this computer: the add-on finds it each time, even though the app starts on a new
   port every launch (it reads the address from the app's `app.json`, as the `rooks` terminal does; only the
   address, never the key in that file). For a server install, set `aiWorkspace.url`, for example
   `http://127.0.0.1:3100`. With the setting empty and no app open, that server address is tried.

## Use

- **AI Workspace: Ask** (or click *AI Workspace* in the status bar). If code is selected it is attached.
- Right-click a selection: **Explain selection** or **Ask about selection**.
- **AI Workspace: New conversation** starts fresh; otherwise each VS Code workspace keeps one running conversation,
  which you can also continue in the app (it shows up under the `cli` channel).

Answers and tool activity appear in the **AI Workspace** output panel.

## Build

```
npm install
npm test          # compiles and runs the client and address tests against a local fake server
npm run package   # builds ai-workspace-0.1.0.vsix (install with: code --install-extension ai-workspace-0.1.0.vsix)
```
