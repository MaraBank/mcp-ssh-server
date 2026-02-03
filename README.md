# MCP SSH Server

MCP server addon for **Claude Desktop** that gives Claude SSH access to your servers — connect, run commands, upload/download files, and transfer files between servers.

## Install (2 steps)

### 1. Open your Claude Desktop config

On Windows, open this file in a text editor:

```
%APPDATA%\Claude\claude_desktop_config.json
```

### 2. Add the SSH server

Paste this into the file:

```json
{
  "mcpServers": {
    "ssh": {
      "command": "npx",
      "args": ["-y", "mcp-ssh-server"]
    }
  }
}
```

Restart Claude Desktop. That's it — Claude now has SSH tools available.

## What you can ask Claude

Once installed, just talk to Claude naturally:

- *"Connect to 185.91.118.4 as root with password mypass123, call it production"*
- *"Run `ls -la /var/www` on production"*
- *"Show me all files in /etc/nginx on production"*
- *"Upload C:\Users\me\app.zip to /tmp/app.zip on production"*
- *"Download /var/log/nginx/error.log from production to my desktop"*
- *"Connect to 10.0.0.5 as deploy with my key at C:\Users\me\.ssh\id_rsa, name it staging"*
- *"Transfer /var/log/app.log from production to /tmp/app.log on staging"*
- *"List all my active sessions"*
- *"Disconnect from staging"*

## Tools

| Tool | What it does |
|------|--------------|
| `ssh_connect` | Connect to a server (password or SSH key) |
| `ssh_disconnect` | Close a connection |
| `ssh_list_sessions` | Show all active connections |
| `ssh_execute` | Run a shell command |
| `ssh_upload` | Upload a local file to a server (SFTP) |
| `ssh_download` | Download a file from a server (SFTP) |
| `ssh_transfer` | Copy a file between two connected servers |
| `ssh_list_files` | List directory contents on a server |

## Building from Source

If you prefer to build it yourself instead of using `npx`:

**Requirements:** [Node.js](https://nodejs.org) 18+ (includes npm)

```bash
git clone https://github.com/MaraBank/mcp-ssh-server.git
cd mcp-ssh-server
npm install
npm run build
```

Then point Claude Desktop to your local build:

```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": ["C:\\full\\path\\to\\mcp-ssh-server\\build\\index.js"]
    }
  }
}
```

## Security

- Credentials are held in memory only for the duration of the session and never written to disk
- Private keys can be referenced by file path or passed as a string
- Connections time out after 30 seconds
- No data is sent anywhere except to the SSH servers you connect to

## License

MIT
