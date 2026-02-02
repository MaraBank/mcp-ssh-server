# MCP SSH Server

An MCP (Model Context Protocol) server and standalone CLI that provides SSH capabilities: connect to remote servers, execute commands, transfer files, switch between servers.

## Download (Standalone EXE)

Go to the [Releases](https://github.com/MaraBank/mcp-ssh-server/releases) page and download:

- **Windows:** `mcp-ssh-win.exe`
- **Linux:** `mcp-ssh-linux`

The EXE is fully self-contained — Node.js is bundled inside. No installation required. Just run it.

> **Note:** Python is **not** required. This tool is built entirely with Node.js. If you need Python on your remote servers, install it there — this SSH client does not need it locally.

## Standalone CLI (EXE)

Double-click or run the EXE from a terminal. On first launch it walks you through adding your first server:

```
  ╔═══════════════════════════════════╗
  ║       MCP SSH Manager v1.0.0      ║
  ╚═══════════════════════════════════╝

  No servers configured yet. Let's add your first server!

  Add a new server

  Name (e.g. production): production
  Host (IP or hostname): 185.91.118.4
  Port [22]: 22
  Username: root
  Auth type (password / key) [password]: password
  Password:

  ℹ Connecting to root@185.91.118.4:22...
  ✓ Connected! Server "production" saved and active.

[production] > ls /var/www
html  mysite

[production] > add staging 10.0.0.5 deploy mypassword123
  ℹ Connecting to deploy@10.0.0.5:22...
  ✓ Connected! Server "staging" saved and active.

[production] > switch staging
  ✓ Switched to "staging".

[staging] > uptime
 12:34:56 up 42 days, ...

[staging] > servers

  Saved Servers

    production  root@185.91.118.4:22    [connected]
    staging     deploy@10.0.0.5:22      [connected] ← active
```

### CLI Commands

| Command | Description |
|---------|-------------|
| `add` | Add a new server (interactive prompts) |
| `add <name> <host> <user> <password>` | Quick-add with password |
| `add <name> <host> <user> key <path>` | Quick-add with SSH key |
| `servers` | List all saved servers |
| `connect <name>` | Connect to a saved server |
| `switch <name>` | Switch active server (auto-connects) |
| `disconnect [name]` | Disconnect from a server |
| `remove <name>` | Remove a saved server |
| `upload <local> <remote>` | Upload a file to the active server |
| `download <remote> <local>` | Download a file from the active server |
| `transfer <srv:path> <srv:path>` | Transfer a file between two servers |
| `help` | Show all commands |
| `exit` | Quit |

Anything else you type is executed as a shell command on the active server.

Server configs are saved to `~/.mcp-ssh/servers.json` so they persist between sessions.

## MCP Server (for Claude Desktop)

This project also includes an MCP server that gives Claude Desktop direct SSH access.

### MCP Tools

| Tool | Description |
|------|-------------|
| `ssh_connect` | Connect to a server (password or key auth) |
| `ssh_disconnect` | Close a session |
| `ssh_list_sessions` | List active sessions |
| `ssh_execute` | Run a command on a connected server |
| `ssh_upload` | Upload a local file to a remote server |
| `ssh_download` | Download a file from a remote server |
| `ssh_transfer` | Transfer a file between two remote servers |
| `ssh_list_files` | List files in a remote directory |

### Configure Claude Desktop (Windows)

Open `%APPDATA%\Claude\claude_desktop_config.json` and add:

```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": ["C:\\path\\to\\mcp-ssh-server\\build\\index.js"]
    }
  }
}
```

Then restart Claude Desktop.

## Building from Source

### Requirements

- **Node.js** 18 or later — [https://nodejs.org](https://nodejs.org)
- **npm** (comes with Node.js)
- **Git** (to clone the repo)

Python is **not** required.

### Steps

```bash
git clone https://github.com/MaraBank/mcp-ssh-server.git
cd mcp-ssh-server
npm install
npm run build
```

This produces `build/index.js` (MCP server) and `build/cli.js` (interactive CLI).

Run the CLI directly:

```bash
node build/cli.js
```

### Building the EXE yourself

After building from source:

```bash
npm run package
```

This creates standalone executables in the `dist/` folder:

- `dist/mcp-ssh-win.exe` — Windows x64
- `dist/mcp-ssh-linux` — Linux x64

The EXE bundles Node.js inside so it runs anywhere with zero dependencies.

## Security Notes

- Passwords for saved servers are stored in `~/.mcp-ssh/servers.json` with `0600` file permissions. Use SSH keys for better security.
- MCP server credentials are held in memory only and never written to disk.
- Connections time out after 30 seconds if unreachable.

## License

MIT
