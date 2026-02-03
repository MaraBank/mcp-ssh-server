#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client, SFTPWrapper } from "ssh2";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// Saved servers (persisted to ~/.mcp-ssh/servers.json)
// ---------------------------------------------------------------------------

interface SavedServer {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
}

const SERVERS_DIR = path.join(os.homedir(), ".mcp-ssh");
const SERVERS_FILE = path.join(SERVERS_DIR, "servers.json");

function loadSavedServers(): Record<string, SavedServer> {
  try {
    if (fs.existsSync(SERVERS_FILE)) {
      return JSON.parse(fs.readFileSync(SERVERS_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function writeSavedServers(servers: Record<string, SavedServer>): void {
  if (!fs.existsSync(SERVERS_DIR)) fs.mkdirSync(SERVERS_DIR, { recursive: true });
  fs.writeFileSync(SERVERS_FILE, JSON.stringify(servers, null, 2));
  try { fs.chmodSync(SERVERS_FILE, 0o600); } catch {}
}

function saveServer(name: string, entry: SavedServer): void {
  const servers = loadSavedServers();
  servers[name] = entry;
  writeSavedServers(servers);
}

function deleteSavedServer(name: string): boolean {
  const servers = loadSavedServers();
  if (!(name in servers)) return false;
  delete servers[name];
  writeSavedServers(servers);
  return true;
}

// ---------------------------------------------------------------------------
// Session store (active connections, in-memory only)
// ---------------------------------------------------------------------------

interface SessionInfo {
  client: Client;
  config: { host: string; port: number; username: string };
}

const sessions = new Map<string, SessionInfo>();

function getSession(sessionName: string): SessionInfo {
  const session = sessions.get(sessionName);
  if (!session) {
    throw new Error(
      `No active session named "${sessionName}". Use ssh_connect to connect or ssh_list_sessions to see available servers.`
    );
  }
  return session;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
  });
}

function execCommand(
  client: Client,
  command: string
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = "";
      let stderr = "";
      stream.on("close", (code: number) => resolve({ stdout, stderr, code: code ?? 0 }));
      stream.on("data", (data: Buffer) => { stdout += data.toString(); });
      stream.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    });
  });
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "mcp-ssh-server",
  version: "1.0.0",
});

// ---- ssh_connect ----------------------------------------------------------

server.tool(
  "ssh_connect",
  "Connect to a remote server via SSH. Provide full details for a new server (it will be saved for next time), or just the sessionName to reconnect to a previously saved server.",
  {
    sessionName: z.string().describe("Friendly name for this session (e.g. 'production'). If this matches a saved server and no host is given, the saved config is used."),
    host: z.string().optional().describe("Hostname or IP address. Omit to connect using a saved server."),
    port: z.number().int().min(1).max(65535).default(22).describe("SSH port (default 22)"),
    username: z.string().optional().describe("SSH username. Omit to use saved server config."),
    password: z.string().optional().describe("Password (omit if using key auth)"),
    privateKeyPath: z.string().optional().describe("Absolute path to a private key file"),
    privateKey: z.string().optional().describe("Private key contents as a string (not saved to disk)"),
    passphrase: z.string().optional().describe("Passphrase for the private key, if encrypted"),
  },
  async ({ sessionName, host, port, username, password, privateKeyPath, privateKey, passphrase }) => {
    if (sessions.has(sessionName)) {
      return {
        content: [{ type: "text" as const, text: `Session "${sessionName}" already exists. Disconnect first or choose a different name.` }],
        isError: true,
      };
    }

    // If host not provided, look up saved server
    if (!host) {
      const saved = loadSavedServers();
      const entry = saved[sessionName];
      if (!entry) {
        return {
          content: [{ type: "text" as const, text: `No saved server named "${sessionName}" and no host provided. Provide host + username for a new connection.` }],
          isError: true,
        };
      }
      host = entry.host;
      port = entry.port;
      username = username ?? entry.username;
      password = password ?? entry.password;
      privateKeyPath = privateKeyPath ?? entry.privateKeyPath;
      passphrase = passphrase ?? entry.passphrase;
    }

    if (!username) {
      return {
        content: [{ type: "text" as const, text: "Username is required." }],
        isError: true,
      };
    }

    // Resolve private key
    let resolvedKey: string | Buffer | undefined;
    if (privateKeyPath) {
      const keyPath = path.resolve(privateKeyPath);
      if (!fs.existsSync(keyPath)) {
        return {
          content: [{ type: "text" as const, text: `Private key file not found: ${keyPath}` }],
          isError: true,
        };
      }
      resolvedKey = fs.readFileSync(keyPath);
    } else if (privateKey) {
      resolvedKey = privateKey;
    }

    if (!password && !resolvedKey) {
      return {
        content: [{ type: "text" as const, text: "Provide either a password or a private key." }],
        isError: true,
      };
    }

    const client = new Client();

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          client.end();
          reject(new Error("Connection timed out after 30 seconds"));
        }, 30_000);

        client.on("ready", () => { clearTimeout(timeout); resolve(); });
        client.on("error", (err) => { clearTimeout(timeout); reject(err); });

        client.connect({ host, port, username, password, privateKey: resolvedKey, passphrase });
      });
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Connection failed: ${err.message}` }],
        isError: true,
      };
    }

    sessions.set(sessionName, { client, config: { host, port, username } });

    // Auto-save server config (never save inline privateKey to disk)
    saveServer(sessionName, {
      host, port, username,
      ...(password ? { password } : {}),
      ...(privateKeyPath ? { privateKeyPath } : {}),
      ...(passphrase ? { passphrase } : {}),
    });

    return {
      content: [{ type: "text" as const, text: `Connected to ${username}@${host}:${port} as "${sessionName}". Server saved for next time.` }],
    };
  }
);

// ---- ssh_disconnect -------------------------------------------------------

server.tool(
  "ssh_disconnect",
  "Close an active SSH session.",
  {
    sessionName: z.string().describe("Name of the session to disconnect"),
  },
  async ({ sessionName }) => {
    const session = sessions.get(sessionName);
    if (!session) {
      return {
        content: [{ type: "text" as const, text: `No active session "${sessionName}".` }],
        isError: true,
      };
    }
    session.client.end();
    sessions.delete(sessionName);
    return {
      content: [{ type: "text" as const, text: `Disconnected "${sessionName}". Server config is still saved — use ssh_connect to reconnect.` }],
    };
  }
);

// ---- ssh_list_sessions ----------------------------------------------------

server.tool(
  "ssh_list_sessions",
  "List all active SSH sessions and saved servers.",
  {},
  async () => {
    const saved = loadSavedServers();
    const allNames = new Set([...sessions.keys(), ...Object.keys(saved)]);

    if (allNames.size === 0) {
      return {
        content: [{ type: "text" as const, text: "No sessions or saved servers. Use ssh_connect to add one." }],
      };
    }

    const lines: string[] = [];
    for (const name of allNames) {
      const active = sessions.has(name);
      const entry = saved[name];
      const info = active
        ? sessions.get(name)!.config
        : entry
        ? { host: entry.host, port: entry.port, username: entry.username }
        : null;

      if (info) {
        const status = active ? "connected" : "saved";
        lines.push(`• ${name} — ${info.username}@${info.host}:${info.port} [${status}]`);
      }
    }
    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  }
);

// ---- ssh_remove_server ----------------------------------------------------

server.tool(
  "ssh_remove_server",
  "Remove a saved server from servers.json and disconnect if currently active.",
  {
    sessionName: z.string().describe("Name of the server to remove"),
  },
  async ({ sessionName }) => {
    const session = sessions.get(sessionName);
    if (session) {
      session.client.end();
      sessions.delete(sessionName);
    }
    const removed = deleteSavedServer(sessionName);
    if (!removed && !session) {
      return {
        content: [{ type: "text" as const, text: `No server named "${sessionName}".` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text" as const, text: `Removed "${sessionName}".` }],
    };
  }
);

// ---- ssh_execute ----------------------------------------------------------

server.tool(
  "ssh_execute",
  "Execute a command on a connected remote server.",
  {
    sessionName: z.string().describe("Session to run the command on"),
    command: z.string().describe("Shell command to execute"),
  },
  async ({ sessionName, command }) => {
    let session: SessionInfo;
    try { session = getSession(sessionName); } catch (err: any) {
      return { content: [{ type: "text" as const, text: err.message }], isError: true };
    }

    try {
      const { stdout, stderr, code } = await execCommand(session.client, command);
      const parts: string[] = [];
      if (stdout) parts.push(stdout);
      if (stderr) parts.push(`[stderr]\n${stderr}`);
      parts.push(`[exit code: ${code}]`);
      return { content: [{ type: "text" as const, text: parts.join("\n") }] };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Execution failed: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ---- ssh_upload -----------------------------------------------------------

server.tool(
  "ssh_upload",
  "Upload a local file to a remote server via SFTP.",
  {
    sessionName: z.string().describe("Session to upload to"),
    localPath: z.string().describe("Absolute path to the local file"),
    remotePath: z.string().describe("Absolute destination path on the remote server"),
  },
  async ({ sessionName, localPath, remotePath }) => {
    let session: SessionInfo;
    try { session = getSession(sessionName); } catch (err: any) {
      return { content: [{ type: "text" as const, text: err.message }], isError: true };
    }

    const resolved = path.resolve(localPath);
    if (!fs.existsSync(resolved)) {
      return {
        content: [{ type: "text" as const, text: `Local file not found: ${resolved}` }],
        isError: true,
      };
    }

    try {
      const sftp = await getSftp(session.client);
      await new Promise<void>((resolve, reject) => {
        sftp.fastPut(resolved, remotePath, (err) => (err ? reject(err) : resolve()));
      });
      return {
        content: [{ type: "text" as const, text: `Uploaded ${resolved} → ${session.config.host}:${remotePath}` }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Upload failed: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ---- ssh_download ---------------------------------------------------------

server.tool(
  "ssh_download",
  "Download a file from a remote server to the local machine via SFTP.",
  {
    sessionName: z.string().describe("Session to download from"),
    remotePath: z.string().describe("Absolute path on the remote server"),
    localPath: z.string().describe("Absolute local destination path"),
  },
  async ({ sessionName, remotePath, localPath }) => {
    let session: SessionInfo;
    try { session = getSession(sessionName); } catch (err: any) {
      return { content: [{ type: "text" as const, text: err.message }], isError: true };
    }

    const resolved = path.resolve(localPath);
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    try {
      const sftp = await getSftp(session.client);
      await new Promise<void>((resolve, reject) => {
        sftp.fastGet(remotePath, resolved, (err) => (err ? reject(err) : resolve()));
      });
      return {
        content: [{ type: "text" as const, text: `Downloaded ${session.config.host}:${remotePath} → ${resolved}` }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Download failed: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ---- ssh_transfer ---------------------------------------------------------

server.tool(
  "ssh_transfer",
  "Transfer a file between two connected remote servers (source → destination) via SFTP.",
  {
    sourceSession: z.string().describe("Session name of the source server"),
    sourceRemotePath: z.string().describe("Absolute file path on the source server"),
    destinationSession: z.string().describe("Session name of the destination server"),
    destinationRemotePath: z.string().describe("Absolute file path on the destination server"),
  },
  async ({ sourceSession, sourceRemotePath, destinationSession, destinationRemotePath }) => {
    let src: SessionInfo;
    let dst: SessionInfo;
    try {
      src = getSession(sourceSession);
      dst = getSession(destinationSession);
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: err.message }], isError: true };
    }

    try {
      const srcSftp = await getSftp(src.client);
      const dstSftp = await getSftp(dst.client);

      const data = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const readStream = srcSftp.createReadStream(sourceRemotePath);
        readStream.on("data", (chunk: Buffer) => chunks.push(chunk));
        readStream.on("end", () => resolve(Buffer.concat(chunks)));
        readStream.on("error", reject);
      });

      await new Promise<void>((resolve, reject) => {
        const writeStream = dstSftp.createWriteStream(destinationRemotePath);
        writeStream.on("close", () => resolve());
        writeStream.on("error", reject);
        writeStream.end(data);
      });

      return {
        content: [{ type: "text" as const, text: `Transferred ${src.config.host}:${sourceRemotePath} → ${dst.config.host}:${destinationRemotePath} (${data.length} bytes)` }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Transfer failed: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ---- ssh_list_files -------------------------------------------------------

server.tool(
  "ssh_list_files",
  "List files and directories in a remote path via SFTP.",
  {
    sessionName: z.string().describe("Session to list files on"),
    remotePath: z.string().describe("Absolute directory path on the remote server"),
  },
  async ({ sessionName, remotePath }) => {
    let session: SessionInfo;
    try { session = getSession(sessionName); } catch (err: any) {
      return { content: [{ type: "text" as const, text: err.message }], isError: true };
    }

    try {
      const sftp = await getSftp(session.client);
      const list = await new Promise<any[]>((resolve, reject) => {
        sftp.readdir(remotePath, (err, list) => (err ? reject(err) : resolve(list)));
      });

      if (list.length === 0) {
        return {
          content: [{ type: "text" as const, text: `Directory is empty: ${remotePath}` }],
        };
      }

      const lines = list.map((entry) => {
        const mode = entry.attrs.mode;
        const isDir = (mode & 0o170000) === 0o040000;
        const isLink = (mode & 0o170000) === 0o120000;
        const typeChar = isDir ? "d" : isLink ? "l" : "-";
        const size = entry.attrs.size ?? 0;
        return `${typeChar} ${String(size).padStart(10)} ${entry.filename}`;
      });

      return {
        content: [{ type: "text" as const, text: `${remotePath} (${list.length} entries):\n${lines.join("\n")}` }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `List failed: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Installer — runs when user executes `npx -y mcp-ssh-server` in a terminal
// ---------------------------------------------------------------------------

function getClaudeConfigPath(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
}

function install(): void {
  console.log("");
  console.log("  MCP SSH Server — Setup");
  console.log("  ──────────────────────");
  console.log("");

  const configPath = getClaudeConfigPath();
  const configDir = path.dirname(configPath);

  // Read existing config or start fresh
  let config: any = {};
  if (fs.existsSync(configPath)) {
    try { config = JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch { config = {}; }
  }

  // Check if already installed
  const existing = config?.mcpServers?.ssh;
  if (existing && JSON.stringify(existing.args || []).includes("mcp-ssh-server")) {
    console.log("  Already installed!");
    console.log("");
    console.log("  Restart Claude Desktop if you haven't already, then tell Claude:");
    console.log('  → "Connect to my server at 192.168.1.100 as root with password xyz"');
    console.log("");
    console.log(`  Config:  ${configPath}`);
    console.log(`  Servers: ${SERVERS_FILE}`);
    console.log("");
    return;
  }

  // Add our entry (preserves any existing mcpServers)
  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers.ssh = {
    command: "npx",
    args: ["-y", "mcp-ssh-server"],
  };

  // Write config
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  console.log("  Done! SSH server added to Claude Desktop.");
  console.log("");
  console.log("  Next:");
  console.log("    1. Restart Claude Desktop");
  console.log("    2. Tell Claude what server to connect to, for example:");
  console.log('       "Connect to 185.91.118.4 as root, password mypass, call it production"');
  console.log("");
  console.log("  Claude will remember your servers. You can also edit them manually:");
  console.log(`    ${SERVERS_FILE}`);
  console.log("");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  // Terminal (user ran the command) → install into Claude Desktop
  // Piped stdin (Claude Desktop launched us) → run as MCP server
  if (process.stdin.isTTY) {
    install();
    return;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP SSH Server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
