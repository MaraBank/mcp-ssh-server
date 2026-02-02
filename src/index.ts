#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client, SFTPWrapper } from "ssh2";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

interface SessionInfo {
  client: Client;
  config: { host: string; port: number; username: string };
}

const sessions = new Map<string, SessionInfo>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSession(sessionName: string): SessionInfo {
  const session = sessions.get(sessionName);
  if (!session) {
    throw new Error(
      `No active session named "${sessionName}". Use ssh_list_sessions to see active sessions.`
    );
  }
  return session;
}

function getSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) reject(err);
      else resolve(sftp);
    });
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

      stream.on("close", (code: number) => {
        resolve({ stdout, stderr, code: code ?? 0 });
      });
      stream.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      stream.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
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
  "Connect to a remote server via SSH. Supports password and private-key authentication.",
  {
    sessionName: z.string().describe("A friendly name for this session (e.g. 'prod-web')"),
    host: z.string().describe("Hostname or IP address"),
    port: z.number().int().min(1).max(65535).default(22).describe("SSH port (default 22)"),
    username: z.string().describe("SSH username"),
    password: z.string().optional().describe("Password (omit if using key auth)"),
    privateKeyPath: z
      .string()
      .optional()
      .describe("Absolute path to a private key file (e.g. C:\\\\Users\\\\me\\\\.ssh\\\\id_rsa)"),
    privateKey: z
      .string()
      .optional()
      .describe("Private key contents as a string (alternative to privateKeyPath)"),
    passphrase: z.string().optional().describe("Passphrase for the private key, if encrypted"),
  },
  async ({ sessionName, host, port, username, password, privateKeyPath, privateKey, passphrase }) => {
    if (sessions.has(sessionName)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Session "${sessionName}" already exists. Disconnect first or choose a different name.`,
          },
        ],
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
        content: [
          {
            type: "text" as const,
            text: "You must provide either a password or a private key (privateKeyPath or privateKey).",
          },
        ],
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

        client.on("ready", () => {
          clearTimeout(timeout);
          resolve();
        });
        client.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });

        client.connect({
          host,
          port,
          username,
          password,
          privateKey: resolvedKey,
          passphrase,
        });
      });
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Connection failed: ${err.message}` }],
        isError: true,
      };
    }

    sessions.set(sessionName, { client, config: { host, port, username } });

    return {
      content: [
        {
          type: "text" as const,
          text: `Connected to ${username}@${host}:${port} as session "${sessionName}".`,
        },
      ],
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
        content: [{ type: "text" as const, text: `No session named "${sessionName}".` }],
        isError: true,
      };
    }
    session.client.end();
    sessions.delete(sessionName);
    return {
      content: [{ type: "text" as const, text: `Session "${sessionName}" disconnected.` }],
    };
  }
);

// ---- ssh_list_sessions ----------------------------------------------------

server.tool(
  "ssh_list_sessions",
  "List all active SSH sessions.",
  {},
  async () => {
    if (sessions.size === 0) {
      return {
        content: [{ type: "text" as const, text: "No active sessions." }],
      };
    }
    const lines = Array.from(sessions.entries()).map(
      ([name, { config }]) => `• ${name} — ${config.username}@${config.host}:${config.port}`
    );
    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
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
    try {
      session = getSession(sessionName);
    } catch (err: any) {
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
    try {
      session = getSession(sessionName);
    } catch (err: any) {
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
        sftp.fastPut(resolved, remotePath, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Uploaded ${resolved} → ${session.config.host}:${remotePath}`,
          },
        ],
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
    try {
      session = getSession(sessionName);
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: err.message }], isError: true };
    }

    const resolved = path.resolve(localPath);

    // Ensure parent directory exists
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    try {
      const sftp = await getSftp(session.client);
      await new Promise<void>((resolve, reject) => {
        sftp.fastGet(remotePath, resolved, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Downloaded ${session.config.host}:${remotePath} → ${resolved}`,
          },
        ],
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

      // Read entire file from source into memory buffer
      const data = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const readStream = srcSftp.createReadStream(sourceRemotePath);
        readStream.on("data", (chunk: Buffer) => chunks.push(chunk));
        readStream.on("end", () => resolve(Buffer.concat(chunks)));
        readStream.on("error", reject);
      });

      // Write buffer to destination
      await new Promise<void>((resolve, reject) => {
        const writeStream = dstSftp.createWriteStream(destinationRemotePath);
        writeStream.on("close", () => resolve());
        writeStream.on("error", reject);
        writeStream.end(data);
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Transferred ${src.config.host}:${sourceRemotePath} → ${dst.config.host}:${destinationRemotePath} (${data.length} bytes)`,
          },
        ],
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
    try {
      session = getSession(sessionName);
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: err.message }], isError: true };
    }

    try {
      const sftp = await getSftp(session.client);
      const list = await new Promise<any[]>((resolve, reject) => {
        sftp.readdir(remotePath, (err, list) => {
          if (err) reject(err);
          else resolve(list);
        });
      });

      if (list.length === 0) {
        return {
          content: [{ type: "text" as const, text: `Directory is empty: ${remotePath}` }],
        };
      }

      const lines = list.map((entry) => {
        const typeChar = entry.attrs.isDirectory() ? "d" : entry.attrs.isSymbolicLink() ? "l" : "-";
        const size = entry.attrs.size ?? 0;
        return `${typeChar} ${String(size).padStart(10)} ${entry.filename}`;
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `${remotePath} (${list.length} entries):\n${lines.join("\n")}`,
          },
        ],
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
// Startup
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP SSH Server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
