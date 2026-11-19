# Claude in Zen

Let Claude drive the [Zen browser](https://zen-browser.app) the way Claude in Chrome drives Chrome: open tabs, read pages, click, type, fill forms, take screenshots, read console and network logs, and run JavaScript. Also works in regular Firefox 140+.

Unofficial community project, not made or supported by Anthropic or the Zen team.

```
Claude Desktop / Claude Code ──stdio──▶ server/server.js ──ws://127.0.0.1:18765──▶ Zen extension ──▶ your tabs
```

It has two parts:

- **`extension/`**: a WebExtension that lives in Zen and connects out to the local server.
- **`server/`**: a small Node.js MCP server (one dependency, `ws`). Claude starts it on demand; it idles at about 40 MB RAM and ~0% CPU. `manifest.json` at the repo root packages it as a one-click Claude Desktop extension (`.mcpb`).

## Requirements

- Zen Browser (or Firefox) 140 or newer
- Claude Desktop and/or Claude Code
- Node.js 18+ only if you build from source or use Claude Code (free, [nodejs.org](https://nodejs.org))

## Install

### 1. Add the server to Claude

**Claude Desktop (easiest).** Download `claude-bridge-for-zen.mcpb` from the [Releases](https://github.com/ASDFboy/claude-in-zen/releases) page, double-click it, and click **Install**. Then fully quit Claude Desktop (tray icon → Quit) and reopen it. It shows up under Settings → Extensions as **Zen Browser (Claude Bridge)**.

To build the bundle yourself instead:

```bash
git clone https://github.com/ASDFboy/claude-in-zen.git
cd claude-in-zen/server && npm install && cd ..
npx @anthropic-ai/mcpb pack . claude-bridge-for-zen.mcpb
```

**Claude Code:**

```bash
git clone https://github.com/ASDFboy/claude-in-zen.git
cd claude-in-zen/server && npm install
claude mcp add zen -s user -- node /full/path/to/claude-in-zen/server/server.js
```

**Claude Desktop, manual config** (if you'd rather not use the bundle): run `npm install` in `server/`, then add this to `claude_desktop_config.json` (Settings → Developer → Edit Config) and restart Claude Desktop:

```json
{
  "mcpServers": {
    "zen": {
      "command": "node",
      "args": ["C:/full/path/to/claude-in-zen/server/server.js"]
    }
  }
}
```

### 2. Install the extension in Zen

Zen, like release Firefox, only installs **signed** extensions permanently, and it ignores the `xpinstall.signatures.required` setting. Two free options:

**Quick test (removed when Zen restarts):** open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…**, and pick `extension/manifest.json` (or the unsigned `.xpi` from Releases).

**Permanent (one-time, free):** sign it yourself as an *unlisted* add-on. Nothing gets published; Mozilla just signs the file for you.

1. Sign in at <https://addons.mozilla.org/developers/addon/api/key/> and generate API credentials.
2. Put them in environment variables, not in a file, and sign:
   ```powershell
   $env:WEB_EXT_API_KEY = "user:12345:67"
   $env:WEB_EXT_API_SECRET = "your-secret"
   cd claude-in-zen\extension
   npx web-ext sign --channel=unlisted
   ```
   (Or upload a zip of the `extension/` folder at the Developer Hub, choose **On your own**, and download the signed file.)
3. Drag the signed `.xpi` from `web-ext-artifacts\` onto a Zen window and click **Add**.

Mozilla only signs a given add-on ID once per account, so before signing **change `browser_specific_settings.gecko.id`** in `extension/manifest.json` to something unique, like `claude-bridge@yourname.dev`. When signing a later version, bump `"version"` first.

### 3. Check it's connected

Click the Claude Bridge icon in Zen's toolbar (pin it from the extensions menu if it's hidden). It should say **Connected**. Then ask Claude something like *"In Zen, open example.com and tell me the page title."*

## Using it

If Zen isn't open when Claude needs it, the server starts it automatically. It looks in the usual install locations (`C:\Program Files\Zen Browser`, `%LOCALAPPDATA%`, the Windows App Paths registry entry, `/Applications` on macOS, and `/usr/bin` or `/opt` on Linux). You can turn this off or point it at a custom install in Claude Desktop → Settings → Extensions → Zen Browser (Claude Bridge). Outside the bundle, set `ZEN_AUTO_LAUNCH=0` or `ZEN_PATH`.

The toolbar icon shows **!** while waiting for Claude, nothing when connected, **…** if another browser holds the bridge, and **❚❚** when paused.

By default Claude can only touch **tabs it opened itself** and **tabs you share** (toolbar icon → *Share this tab with Claude*). Shared tabs get a thin orange border. The popup also has:

- **Pause Claude**: a kill switch. Every browser action is refused until you untick it.
- **Allow access to all tabs**: off by default.
- **Port**: change it if 18765 is taken, and set `ZEN_BRIDGE_PORT` to match in the server's environment.
- **Reconnect / Use this browser**: if the extension runs in two browsers, the first one to connect keeps the bridge; this switches it to the current one.

To make Claude use Zen whenever you ask for something in a browser, tell it so (for example, save it as a preference in Claude's memory).

## Tools

| Tool | What it does |
|---|---|
| `tabs_context` | List tabs Claude may use |
| `tabs_create` / `tabs_close` / `tabs_select` | Open, close, focus tabs |
| `navigate` | Go to a URL, or `back` / `forward` / `reload` |
| `computer` | `screenshot`, `zoom`, clicks (by `ref` or coordinate), `hover`, `left_click_drag`, `type`, `key`, `scroll`, `scroll_to`, `wait` |
| `read_page` | Page outline with a `ref` for every control (`filter: "interactive"` for controls only) |
| `find` | Find elements by text or label and get their refs |
| `form_input` | Set inputs, selects, and checkboxes by ref |
| `get_page_text` | Readable page text |
| `javascript_tool` | Run JS in the page (page globals via `window.wrappedJSObject`) |
| `read_console_messages` | Console output and uncaught errors since page load |
| `read_network_requests` | HTTP requests (the first call starts recording) |
| `resize_window` | Resize the window |

## Limits compared with Claude in Chrome

Firefox gives extensions no debugger protocol, so input is simulated with DOM events rather than real OS input. That works for plain forms, React-controlled inputs, contenteditable editors, links, and submit-on-Enter, but:

- CSS-only `:hover` menus can't be opened by hovering; click them or use `read_page`.
- Sites that check `event.isTrusted` (rare; some games and anti-bot widgets) ignore the clicks.
- Native dialogs (file pickers, `alert()` boxes, print) can't be operated.
- Browser-internal pages (`about:*`, the new-tab page, addons.mozilla.org) are off-limits to every extension.
- Cross-origin iframes aren't read or clicked into.

## Security

- The server listens on `127.0.0.1` only and accepts the browser connection only from a `moz-extension://` origin, so websites can't connect to it (DNS-rebinding requests are rejected too).
- Nothing leaves your machine through the bridge; screenshots and page text go only to the Claude app that started the server.
- Shared-tab IDs are kept in session storage, so after a browser restart nothing is shared until Claude opens a tab or you share one.
- Anything Claude can see in a tab, it can act on. Keep **Pause Claude** handy, and don't share tabs you wouldn't want automated.

## Authors

ASDFboy.

## License

[MIT](LICENSE)
