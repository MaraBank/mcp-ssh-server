#!/usr/bin/env node

import * as readline from "readline";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { Client, SFTPWrapper } from "ssh2";

// ── ANSI Colors ─────────────────────────────────────────────────────────────

const R = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

// ── Types ───────────────────────────────────────────────────────────────────

interface ServerEntry {
  name: string;
  host: string;
  port: number;
  username: string;
  authType: "password" | "key";
  password?: string;
  keyPath?: string;
  passphrase?: string;
}

interface Config {
  servers: ServerEntry[];
}

// ── Globals ─────────────────────────────────────────────────────────────────

const CONFIG_DIR = path.join(os.homedir(), ".mcp-ssh");
const CONFIG_FILE = path.join(CONFIG_DIR, "servers.json");

const liveConnections = new Map<string, Client>();
let activeServer: string | null = null;
let config: Config = { servers: [] };
let rl: readline.Interface;

// ── Config I/O ──────────────────────────────────────────────────────────────

function loadConfig(): Config {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch {}
  return { servers: [] };
}

function saveConfig(): void {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch {}
}

// ── Output ──────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(msg);
}
function err(msg: string) {
  console.log(`${RED}  ✗ ${msg}${R}`);
}
function ok(msg: string) {
  console.log(`${GREEN}  ✓ ${msg}${R}`);
}
function info(msg: string) {
  console.log(`${CYAN}  ℹ ${msg}${R}`);
}
function warn(msg: string) {
  console.log(`${YELLOW}  ⚠ ${msg}${R}`);
}

// ── Prompts ─────────────────────────────────────────────────────────────────

function ask(prompt: string, defaultVal?: string): Promise<string> {
  const suffix = defaultVal ? ` ${DIM}[${defaultVal}]${R}` : "";
  return new Promise((resolve) => {
    rl.question(`  ${prompt}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultVal || "");
    });
  });
}

function askPassword(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const origWrite = (rl as any)._writeToOutput;
    if (origWrite) {
      (rl as any)._writeToOutput = function (str: string) {
        // Show the prompt itself and newlines, suppress typed characters
        if (str.includes(prompt) || str === "\r\n" || str === "\n" || str === "\r") {
          origWrite.call(this, str);
        }
      };
    }

    rl.question(`  ${prompt}: `, (answer) => {
      if (origWrite) {
        (rl as any)._writeToOutput = origWrite;
      }
      log(""); // newline after hidden input
      resolve(answer);
    });
  });
}

// ── SSH Helpers ─────────────────────────────────────────────────────────────

function sshConnect(entry: ServerEntry): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const timeout = setTimeout(() => {
      client.end();
      reject(new Error("Connection timed out (30s)"));
    }, 30_000);

    client.on("ready", () => {
      clearTimeout(timeout);
      resolve(client);
    });
    client.on("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
    client.on("close", () => {
      if (liveConnections.get(entry.name) === client) {
        liveConnections.delete(entry.name);
        if (activeServer === entry.name) {
          activeServer = null;
          warn(`Connection to "${entry.name}" lost.`);
        }
      }
    });

    const opts: any = {
      host: entry.host,
      port: entry.port,
      username: entry.username,
    };
    if (entry.authType === "key" && entry.keyPath) {
      opts.privateKey = fs.readFileSync(path.resolve(entry.keyPath));
      if (entry.passphrase) opts.passphrase = entry.passphrase;
    } else {
      opts.password = entry.password;
    }
    client.connect(opts);
  });
}

function sshExec(
  client: Client,
  command: string
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    client.exec(command, (e, stream) => {
      if (e) return reject(e);
      let stdout = "";
      let stderr = "";
      stream.on("close", (code: number) =>
        resolve({ stdout, stderr, code: code ?? 0 })
      );
      stream.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      stream.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
    });
  });
}

function getSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((e, sftp) => (e ? reject(e) : resolve(sftp)));
  });
}

function getActiveClient(): Client | null {
  if (!activeServer) return null;
  return liveConnections.get(activeServer) ?? null;
}

function findServer(name: string): ServerEntry | undefined {
  return config.servers.find((s) => s.name === name);
}

// ── Command: add ────────────────────────────────────────────────────────────

async function cmdAdd(args: string[]): Promise<void> {
  let entry: ServerEntry;

  if (args.length >= 4) {
    // Quick add: add <name> <host> <username> <password>
    //            add <name> <host> <port> <username> <password>
    //            add <name> <host> <username> key <keypath>
    const name = args[0];
    const host = args[1];
    let port = 22;
    let idx = 2;

    // If third arg is numeric, treat as port
    if (/^\d+$/.test(args[idx])) {
      port = parseInt(args[idx], 10);
      idx++;
    }
    const username = args[idx++];

    if (args[idx] === "key") {
      entry = {
        name,
        host,
        port,
        username,
        authType: "key",
        keyPath: args[idx + 1],
        passphrase: args[idx + 2] || undefined,
      };
    } else if (args[idx] === "password") {
      entry = {
        name,
        host,
        port,
        username,
        authType: "password",
        password: args[idx + 1],
      };
    } else {
      // Assume the remaining arg is the password itself
      entry = {
        name,
        host,
        port,
        username,
        authType: "password",
        password: args[idx],
      };
    }
  } else {
    // Interactive add
    log("");
    log(`${BOLD}  Add a new server${R}`);
    log("");
    const name = await ask("Name (e.g. production)");
    if (!name) {
      err("Name is required.");
      return;
    }
    const host = await ask("Host (IP or hostname)");
    if (!host) {
      err("Host is required.");
      return;
    }
    const portStr = await ask("Port", "22");
    const port = parseInt(portStr, 10) || 22;
    const username = await ask("Username");
    if (!username) {
      err("Username is required.");
      return;
    }
    const authType = (
      await ask("Auth type (password / key)", "password")
    ).toLowerCase();

    if (authType === "key") {
      const keyPath = await ask("Path to private key");
      if (!keyPath) {
        err("Key path is required.");
        return;
      }
      const passphrase = await ask("Key passphrase (leave empty if none)");
      entry = {
        name,
        host,
        port,
        username,
        authType: "key",
        keyPath,
        passphrase: passphrase || undefined,
      };
    } else {
      const password = await askPassword("Password");
      entry = { name, host, port, username, authType: "password", password };
    }
    log("");
  }

  if (findServer(entry.name)) {
    err(
      `Server "${entry.name}" already exists. Remove it first or choose a different name.`
    );
    return;
  }

  info(`Connecting to ${entry.username}@${entry.host}:${entry.port}...`);
  try {
    const client = await sshConnect(entry);
    liveConnections.set(entry.name, client);
    activeServer = entry.name;
    config.servers.push(entry);
    saveConfig();
    ok(`Connected! Server "${entry.name}" saved and active.`);
  } catch (e: any) {
    err(`Connection failed: ${e.message}`);
  }
}

// ── Command: servers ────────────────────────────────────────────────────────

function cmdServers(): void {
  if (config.servers.length === 0) {
    info("No servers saved. Use 'add' to add one.");
    return;
  }
  log("");
  log(`${BOLD}  Saved Servers${R}`);
  log("");
  for (const s of config.servers) {
    const connected = liveConnections.has(s.name);
    const isActive = s.name === activeServer;
    const status = connected
      ? `${GREEN}connected${R}`
      : `${DIM}disconnected${R}`;
    const marker = isActive ? ` ${YELLOW}← active${R}` : "";
    log(
      `    ${BOLD}${s.name}${R}  ${s.username}@${s.host}:${s.port}  [${status}]${marker}`
    );
  }
  log("");
}

// ── Command: connect ────────────────────────────────────────────────────────

async function cmdConnect(name: string): Promise<void> {
  if (!name) {
    err("Usage: connect <name>");
    return;
  }
  const entry = findServer(name);
  if (!entry) {
    err(`No saved server named "${name}".`);
    return;
  }
  if (liveConnections.has(name)) {
    info(`Already connected to "${name}".`);
    activeServer = name;
    return;
  }

  info(`Connecting to ${entry.username}@${entry.host}:${entry.port}...`);
  try {
    const client = await sshConnect(entry);
    liveConnections.set(name, client);
    activeServer = name;
    ok(`Connected to "${name}".`);
  } catch (e: any) {
    err(`Connection failed: ${e.message}`);
  }
}

// ── Command: switch ─────────────────────────────────────────────────────────

async function cmdSwitch(name: string): Promise<void> {
  if (!name) {
    err("Usage: switch <name>");
    return;
  }
  const entry = findServer(name);
  if (!entry) {
    err(`No saved server named "${name}".`);
    return;
  }
  if (!liveConnections.has(name)) {
    info(`Not connected to "${name}", connecting...`);
    try {
      const client = await sshConnect(entry);
      liveConnections.set(name, client);
    } catch (e: any) {
      err(`Connection failed: ${e.message}`);
      return;
    }
  }
  activeServer = name;
  ok(`Switched to "${name}".`);
}

// ── Command: disconnect ─────────────────────────────────────────────────────

function cmdDisconnect(name?: string): void {
  const target = name || activeServer;
  if (!target) {
    err("No active server. Usage: disconnect <name>");
    return;
  }
  const client = liveConnections.get(target);
  if (!client) {
    err(`"${target}" is not connected.`);
    return;
  }
  client.end();
  liveConnections.delete(target);
  if (activeServer === target) activeServer = null;
  ok(`Disconnected from "${target}".`);
}

// ── Command: remove ─────────────────────────────────────────────────────────

function cmdRemove(name: string): void {
  if (!name) {
    err("Usage: remove <name>");
    return;
  }
  const idx = config.servers.findIndex((s) => s.name === name);
  if (idx === -1) {
    err(`No saved server named "${name}".`);
    return;
  }
  const client = liveConnections.get(name);
  if (client) {
    client.end();
    liveConnections.delete(name);
  }
  if (activeServer === name) activeServer = null;

  config.servers.splice(idx, 1);
  saveConfig();
  ok(`Server "${name}" removed.`);
}

// ── Command: upload ─────────────────────────────────────────────────────────

async function cmdUpload(localPath: string, remotePath: string): Promise<void> {
  if (!localPath || !remotePath) {
    err("Usage: upload <local-path> <remote-path>");
    return;
  }
  const client = getActiveClient();
  if (!client) {
    err("No active server. Connect or switch first.");
    return;
  }
  const resolved = path.resolve(localPath);
  if (!fs.existsSync(resolved)) {
    err(`Local file not found: ${resolved}`);
    return;
  }
  try {
    const sftp = await getSftp(client);
    await new Promise<void>((resolve, reject) => {
      sftp.fastPut(resolved, remotePath, (e) => (e ? reject(e) : resolve()));
    });
    ok(`Uploaded ${resolved} → ${activeServer}:${remotePath}`);
  } catch (e: any) {
    err(`Upload failed: ${e.message}`);
  }
}

// ── Command: download ───────────────────────────────────────────────────────

async function cmdDownload(
  remotePath: string,
  localPath: string
): Promise<void> {
  if (!remotePath || !localPath) {
    err("Usage: download <remote-path> <local-path>");
    return;
  }
  const client = getActiveClient();
  if (!client) {
    err("No active server. Connect or switch first.");
    return;
  }
  const resolved = path.resolve(localPath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  try {
    const sftp = await getSftp(client);
    await new Promise<void>((resolve, reject) => {
      sftp.fastGet(remotePath, resolved, (e) => (e ? reject(e) : resolve()));
    });
    ok(`Downloaded ${activeServer}:${remotePath} → ${resolved}`);
  } catch (e: any) {
    err(`Download failed: ${e.message}`);
  }
}

// ── Command: transfer ───────────────────────────────────────────────────────

async function cmdTransfer(from: string, to: string): Promise<void> {
  if (!from || !to || !from.includes(":") || !to.includes(":")) {
    err("Usage: transfer <server>:<remote-path> <server>:<remote-path>");
    return;
  }
  const [srcName, ...srcParts] = from.split(":");
  const srcPath = srcParts.join(":");
  const [dstName, ...dstParts] = to.split(":");
  const dstPath = dstParts.join(":");

  if (!srcName || !srcPath || !dstName || !dstPath) {
    err("Usage: transfer <server>:<remote-path> <server>:<remote-path>");
    return;
  }

  const srcClient = liveConnections.get(srcName);
  const dstClient = liveConnections.get(dstName);
  if (!srcClient) {
    err(`"${srcName}" is not connected.`);
    return;
  }
  if (!dstClient) {
    err(`"${dstName}" is not connected.`);
    return;
  }

  try {
    info(`Reading from ${srcName}:${srcPath}...`);
    const srcSftp = await getSftp(srcClient);
    const data = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const s = srcSftp.createReadStream(srcPath);
      s.on("data", (c: Buffer) => chunks.push(c));
      s.on("end", () => resolve(Buffer.concat(chunks)));
      s.on("error", reject);
    });

    info(`Writing to ${dstName}:${dstPath} (${data.length} bytes)...`);
    const dstSftp = await getSftp(dstClient);
    await new Promise<void>((resolve, reject) => {
      const s = dstSftp.createWriteStream(dstPath);
      s.on("close", () => resolve());
      s.on("error", reject);
      s.end(data);
    });

    ok(
      `Transferred ${srcName}:${srcPath} → ${dstName}:${dstPath} (${data.length} bytes)`
    );
  } catch (e: any) {
    err(`Transfer failed: ${e.message}`);
  }
}

// ── Command: help ───────────────────────────────────────────────────────────

function cmdHelp(): void {
  log(`
${BOLD}  Connection Commands${R}
    ${CYAN}add${R}                                 Add a new server (interactive)
    ${CYAN}add${R} <name> <host> <user> <password>  Add a server (quick)
    ${CYAN}add${R} <name> <host> <user> key <path>  Add a server with SSH key
    ${CYAN}servers${R}                              List all saved servers
    ${CYAN}connect${R} <name>                       Connect to a saved server
    ${CYAN}switch${R} <name>                        Switch active server
    ${CYAN}disconnect${R} [name]                    Disconnect (default: active)
    ${CYAN}remove${R} <name>                        Remove a saved server

${BOLD}  File Commands${R}
    ${CYAN}upload${R} <local> <remote>              Upload file to active server
    ${CYAN}download${R} <remote> <local>            Download file from active server
    ${CYAN}transfer${R} <srv:path> <srv:path>       Transfer file between servers

${BOLD}  Other${R}
    ${CYAN}help${R}                                 Show this help
    ${CYAN}exit${R}                                 Exit

  ${DIM}Anything else you type is executed as a command on the active server.${R}
`);
}

// ── REPL ────────────────────────────────────────────────────────────────────

function getPrompt(): string {
  if (activeServer) {
    return `${GREEN}[${activeServer}]${R} > `;
  }
  return `${DIM}[no server]${R} > `;
}

async function processLine(line: string): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;

  // Parse: first word is the command, rest are args
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  switch (cmd) {
    case "add":
      await cmdAdd(args);
      break;

    case "servers":
    case "list":
      cmdServers();
      break;

    case "connect":
      await cmdConnect(args[0]);
      break;

    case "switch":
      await cmdSwitch(args[0]);
      break;

    case "disconnect":
      cmdDisconnect(args[0]);
      break;

    case "remove":
    case "delete":
      cmdRemove(args[0]);
      break;

    case "upload":
      await cmdUpload(args[0], args[1]);
      break;

    case "download":
      await cmdDownload(args[0], args[1]);
      break;

    case "transfer":
      await cmdTransfer(args[0], args[1]);
      break;

    case "help":
    case "?":
      cmdHelp();
      break;

    case "exit":
    case "quit":
      for (const [, client] of liveConnections) {
        client.end();
      }
      liveConnections.clear();
      log("\n  Goodbye!\n");
      process.exit(0);
      break;

    default:
      // Execute as remote command on the active server
      if (!activeServer || !getActiveClient()) {
        err(
          "No active server. Use 'add' to add a server or 'connect <name>' to connect."
        );
        return;
      }
      try {
        const { stdout, stderr, code } = await sshExec(
          getActiveClient()!,
          trimmed
        );
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(`${RED}${stderr}${R}`);
        if (code !== 0) log(`${DIM}[exit code: ${code}]${R}`);
      } catch (e: any) {
        err(`Execution failed: ${e.message}`);
      }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log(`
${BOLD}  ╔═══════════════════════════════════╗
  ║       MCP SSH Manager v1.0.0      ║
  ╚═══════════════════════════════════╝${R}
`);

  config = loadConfig();

  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  // Graceful Ctrl+C
  rl.on("SIGINT", () => {
    log(`\n  ${DIM}Type 'exit' to quit.${R}`);
    rl.prompt();
  });

  // First-run setup
  if (config.servers.length === 0) {
    log(`${YELLOW}  No servers configured yet. Let's add your first server!${R}`);
    await cmdAdd([]);
    log("");
  } else {
    // Auto-connect to first saved server
    const first = config.servers[0];
    if (!liveConnections.has(first.name)) {
      info(`Auto-connecting to "${first.name}" (${first.username}@${first.host})...`);
      try {
        const client = await sshConnect(first);
        liveConnections.set(first.name, client);
        activeServer = first.name;
        ok(`Connected to "${first.name}".`);
      } catch (e: any) {
        warn(`Could not connect to "${first.name}": ${e.message}`);
      }
    }
    log(`\n  Type ${CYAN}help${R} for available commands.\n`);
  }

  // REPL loop
  const prompt = () => {
    rl.question(getPrompt(), async (line) => {
      await processLine(line);
      prompt();
    });
  };
  prompt();
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
