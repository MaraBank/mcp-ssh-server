# MCP SSH Server

An MCP (Model Context Protocol) server that gives Claude Desktop SSH capabilities: connect to remote servers, execute commands, transfer files, and manage multiple sessions.

## Features

- **Connect** to remote servers via password or SSH key authentication
- **Execute commands** on any connected server
- **Upload / Download** files via SFTP
- **Transfer files** directly between two connected servers
- **List files** in remote directories
- **Manage multiple sessions** simultaneously with friendly names

## Tools

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

## Setup

### 1. Build

```bash
npm install
npm run build
```

### 2. Configure Claude Desktop (Windows)

Open the Claude Desktop config file at:

```
%APPDATA%\Claude\claude_desktop_config.json
```

Add this server to the `mcpServers` section:

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

Replace `C:\\path\\to\\mcp-ssh-server` with the actual path where you cloned/built this project.

### 3. Restart Claude Desktop

Restart Claude Desktop for the new MCP server to be detected.

## Usage Examples

**Connect with password:**
> Connect to my server at 192.168.1.100 as user "deploy" with password "secret", name the session "web-prod".

**Connect with SSH key:**
> Connect to example.com as "admin" using my key at C:\Users\me\.ssh\id_rsa, call it "db-server".

**Run a command:**
> On session "web-prod", run `ls -la /var/www`.

**Transfer a file between servers:**
> Transfer /var/log/app.log from "web-prod" to /tmp/app.log on "db-server".

## Security Notes

- Credentials are held in memory only for the duration of the session and are never logged.
- Private keys can be provided as a file path or inline string.
- Connections time out after 30 seconds if the server is unreachable.

## License

MIT
