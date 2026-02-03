# MCP SSH Server

MCP addon for **Claude Desktop** — gives Claude SSH access to your servers.

## Install

Run this one command (requires [Node.js](https://nodejs.org) 18+):

```
npx -y mcp-ssh-server
```

It automatically adds itself to Claude Desktop. Restart Claude Desktop and you're done.

## Usage

Just talk to Claude:

- *"Connect to 185.91.118.4 as root with password mypass, call it production"*
- *"Run `ls -la /var/www` on production"*
- *"Upload C:\Users\me\app.zip to /tmp/app.zip on production"*
- *"Download /var/log/error.log from production"*
- *"Connect to 10.0.0.5 as deploy with key at C:\Users\me\.ssh\id_rsa, name it staging"*
- *"Transfer /var/log/app.log from production to /tmp/app.log on staging"*
- *"List my servers"*
- *"Remove staging"*

## Servers are saved

When you tell Claude to connect to a server, it's saved to `~/.mcp-ssh/servers.json`. Next time just say *"connect to production"* and it reconnects using the saved config.

You can also edit `servers.json` manually:

```json
{
  "production": {
    "host": "185.91.118.4",
    "port": 22,
    "username": "root",
    "password": "mypass"
  },
  "staging": {
    "host": "10.0.0.5",
    "port": 22,
    "username": "deploy",
    "privateKeyPath": "C:\\Users\\me\\.ssh\\id_rsa"
  }
}
```

## Tools

| Tool | What it does |
|------|--------------|
| `ssh_connect` | Connect to a server (new or saved) |
| `ssh_disconnect` | Close a connection |
| `ssh_list_sessions` | Show all connections and saved servers |
| `ssh_remove_server` | Delete a saved server |
| `ssh_execute` | Run a shell command |
| `ssh_upload` | Upload a local file (SFTP) |
| `ssh_download` | Download a remote file (SFTP) |
| `ssh_transfer` | Copy a file between two servers |
| `ssh_list_files` | List remote directory contents |

## Building from Source

```bash
git clone https://github.com/MaraBank/mcp-ssh-server.git
cd mcp-ssh-server
npm install
npm run build
```

Then point Claude Desktop config (`%APPDATA%\Claude\claude_desktop_config.json`) to your local build:

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

## License

MIT
