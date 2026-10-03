import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  type WASocket,
  type BaileysEventMap,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import P from "pino";
import fs from "fs";
import path from "path";
import inquirer from "inquirer";
import chalk from "chalk";
import { setupGlobalHotReload } from "./functions/reloadCommands";

// ─── Types ────────────────────────────────────────────────────────────────────

type SessionSocket = WASocket & { sessionName?: string };

interface PendingSession {
  sock: SessionSocket;
  attempts: number;
  cancelled: boolean;
}

interface StartOptions {
  authMethod?: "qr" | "code";
  phoneNumber?: string;
  qrHandler?: (qr: string, attempt: number) => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
}

interface MyJid {
  id: string;
  lid: string | null;
}

interface Command {
  name: string;
  execute: (
    sock: SessionSocket,
    msg: BaileysEventMap["messages.upsert"]["messages"][number],
    args: string[],
    myJid: MyJid,
    sender: string,
    activeSessions: Record<string, SessionSocket>,
    sessionsToNotReconnect: Set<string>,
    startBotInstance: (name: string, options?: StartOptions) => Promise<SessionSocket | undefined>,
    pendingSessions: Record<string, PendingSession>,
    isSessionFolderEmpty: (sessionPath: string) => boolean
  ) => Promise<void> | void;
}

// ─── Constants ───────────────────────────────────────────────────────────────
const SESSIONS_DIR = "sessions";
const MAX_QR_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 5000;
const commandsPath = path.join(__dirname, "commands");
const sessionCommandsPath = path.join(__dirname, "sessionsCommands");

// ─── State ────────────────────────────────────────────────────────────────────
const activeSessions: Record<string, SessionSocket> = {};
const sessionsToNotReconnect = new Set<string>();
const pendingSessions: Record<string, PendingSession> = {};
const reconnectGuards = new Set<string>();

// ─── Bootstrap ────────────────────────────────────────────────────────────────
if (!fs.existsSync(SESSIONS_DIR)) {
  try {
    fs.mkdirSync(SESSIONS_DIR);
    console.log(chalk.green("Created sessions directory"));
  } catch (error) {
    console.error(chalk.red(`Failed to create sessions directory: ${errMsg(error)}`));
    process.exit(1);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isValidSessionName(name: string): boolean {
  return /^[a-zA-Z0-9-_]{3,20}$/.test(name);
}

function isSessionFolderEmpty(sessionPath: string): boolean {
  try {
    if (!fs.existsSync(sessionPath)) return true;
    const files = fs.readdirSync(sessionPath);
    return files.length === 0 || (files.length === 1 && files[0] === ".DS_Store");
  } catch (error) {
    console.error(chalk.red(`Error checking session folder ${sessionPath}: ${errMsg(error)}`));
    return false;
  }
}

async function cleanupSession(sessionName: string, sessionFolder: string): Promise<void> {
  try {
    if (pendingSessions[sessionName]) {
      pendingSessions[sessionName].sock?.ev?.removeAllListeners("connection.update");
      pendingSessions[sessionName].sock?.end(undefined);
      delete pendingSessions[sessionName];
    }
    if (fs.existsSync(sessionFolder) && isSessionFolderEmpty(sessionFolder)) {
      fs.rmSync(sessionFolder, { recursive: true, force: true });
      console.log(chalk.green(`[${sessionName}] Removed empty session folder`));
    }
  } catch (error) {
    console.error(chalk.red(`[${sessionName}] Error during cleanup: ${errMsg(error)}`));
  }
}

async function loadCommands(dir: string, commands: Map<string, Command>): Promise<void> {
  try {
    if (!fs.existsSync(dir)) {
      console.warn(chalk.yellow(`Commands directory ${dir} does not exist, skipping...`));
      return;
    }
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          await loadCommands(fullPath, commands);
        } else if (file.endsWith(".js")) {
          try {
            delete require.cache[require.resolve(fullPath)];
            const command = require(fullPath) as Partial<Command> | undefined;
            if (command?.name && typeof command.execute === "function") {
              commands.set(command.name, command as Command);
              console.log(chalk.green(`Command loaded ✅ : ${chalk.cyan(command.name)}`));
            } else {
              console.warn(chalk.yellow(`Skipped invalid command at ${fullPath} — missing name or execute`));
            }
          } catch (cmdError) {
            console.error(chalk.red(`Failed to load command from ${fullPath}: ${errMsg(cmdError)}`));
          }
        }
      } catch (fileError) {
        console.error(chalk.red(`Error processing file ${fullPath}: ${errMsg(fileError)}`));
      }
    }
  } catch (dirError) {
    console.error(chalk.red(`Failed to read directory ${dir}: ${errMsg(dirError)}`));
  }
}

// ─── Core ─────────────────────────────────────────────────────────────────────

async function startBotInstance(
  sessionName: string,
  options: StartOptions = {}
): Promise<SessionSocket | undefined> {
  const sessionFolder = path.join(SESSIONS_DIR, sessionName);

  try {
    if (!fs.existsSync(sessionFolder)) {
      fs.mkdirSync(sessionFolder, { recursive: true });
      console.log(chalk.green(`Created session folder for ${chalk.cyan(sessionName)}`));
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

    const sock: SessionSocket = makeWASocket({
      logger: P({ level: "fatal", enabled: false }),
      auth: state,
      printQRInTerminal: false,
      browser: ["omrx", "Arch Linux", "1.0"],
      connectTimeoutMs: 60000,
      retryRequestDelayMs: 1000,
      maxMsgRetryCount: 5,
      keepAliveIntervalMs: 10000,
      markOnlineOnConnect: true,
    });

    sock.ev.on("creds.update", saveCreds);
    sock.sessionName = sessionName;

    // ── Pairing code auth ─────────────────────────────────────────────────────
    if (options.authMethod === "code" && !state.creds.registered) {
      try {
        // Accept phoneNumber from options (e.g. from getSessionFiles command) or prompt
        let phoneNumber = options.phoneNumber;
        if (!phoneNumber && process.stdin.isTTY) {
          const answer = await inquirer.prompt<{ phoneNumber: string }>([
            {
              type: "input",
              name: "phoneNumber",
              message: chalk.cyan(`[${sessionName}] Enter phone number (with country code, no + or spaces):`),
              validate: (input: string) =>
                /^\d{10,15}$/.test(input.trim()) ||
                chalk.red("Invalid number — digits only, 10-15 chars (e.g. 201234567890)"),
            },
          ]);
          phoneNumber = answer.phoneNumber;
        } else if (!phoneNumber) {
          console.error(chalk.red(`[${sessionName}] PHONE_NUMBER required for pairing code auth with no TTY.`));
          return;
        }
        console.log(chalk.yellow(`[${sessionName}] Requesting pairing code...`));
        const code = await sock.requestPairingCode(phoneNumber!.trim());
        console.log(
          chalk.greenBright(`[${sessionName}] Pairing code: `) +
            chalk.bold.white(code) +
            chalk.greenBright(" — Enter this in WhatsApp > Linked Devices > Link with phone number")
        );
      } catch (error) {
        console.error(chalk.red(`[${sessionName}] Failed to get pairing code: ${errMsg(error)}`));
      }
    }

    // ── Connection lifecycle ──────────────────────────────────────────────────
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // QR code (only used when authMethod is "qr" or unset)
      if (qr && options.authMethod !== "code") {
        if (pendingSessions[sessionName]?.cancelled) {
          console.log(chalk.yellow(`[${sessionName}] Session was cancelled, skipping QR.`));
          return;
        }

        if (!pendingSessions[sessionName]) {
          pendingSessions[sessionName] = { sock, attempts: 0, cancelled: false };
        }
        pendingSessions[sessionName].attempts += 1;

        const attempt = pendingSessions[sessionName].attempts;
        console.log(chalk.cyan(`[${sessionName}] QR attempt ${attempt}/${MAX_QR_ATTEMPTS}`));

        if (attempt > MAX_QR_ATTEMPTS) {
          console.log(chalk.red(`[${sessionName}] QR limit reached. Cancelling session.`));
          try {
            await cleanupSession(sessionName, sessionFolder);
            await options.onCancel?.();
          } catch (error) {
            console.error(chalk.red(`[${sessionName}] Error cancelling session: ${errMsg(error)}`));
          }
          return;
        }

        try {
          if (typeof options.qrHandler === "function") {
            await options.qrHandler(qr, attempt);
          } else {
            console.log(chalk.cyan(`[${sessionName}] Scan QR code (${attempt}/${MAX_QR_ATTEMPTS}):`));
            qrcode.generate(qr, { small: true });
          }
        } catch (error) {
          console.error(chalk.red(`[${sessionName}] QR handler error: ${errMsg(error)}`));
          qrcode.generate(qr, { small: true });
        }
      }

      // Connected
      if (connection === "open") {
        console.log(chalk.green(`[${sessionName}] Connected ✅`));
        activeSessions[sessionName] = sock;
        delete pendingSessions[sessionName];
        reconnectGuards.delete(sessionName);
      }

      // Disconnected
      if (connection === "close") {
        const statusCode: number | undefined = (
          lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
        )?.output?.statusCode;
        const reason = statusCode
          ? `${statusCode} - ${(DisconnectReason as Record<number, string>)[statusCode] ?? "Unknown"}`
          : "Unknown reason";

        console.log(chalk.red(`[${sessionName}] Disconnected: ${reason}`));

        delete activeSessions[sessionName];
        delete pendingSessions[sessionName];

        const shouldNotReconnect =
          statusCode === DisconnectReason.loggedOut ||
          statusCode === DisconnectReason.badSession ||
          sessionsToNotReconnect.has(sessionName);

        if (shouldNotReconnect) {
          console.log(chalk.red(`[${sessionName}] Session ended permanently.`));
          sessionsToNotReconnect.delete(sessionName);
          if (statusCode === DisconnectReason.badSession) {
            await cleanupSession(sessionName, sessionFolder);
          }
          return;
        }

        if (reconnectGuards.has(sessionName)) {
          console.log(chalk.yellow(`[${sessionName}] Reconnect already scheduled, skipping.`));
          return;
        }

        reconnectGuards.add(sessionName);
        console.log(chalk.yellow(`[${sessionName}] Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`));
        setTimeout(async () => {
          reconnectGuards.delete(sessionName);
          await startBotInstance(sessionName, options);
        }, RECONNECT_DELAY_MS);
      }
    });

    // ── Message history sync ──────────────────────────────────────────────────
    sock.ev.on("messaging-history.set", () => {
      console.log(chalk.green(`[${sessionName}] Message history synced`));
    });

    // ── Commands ──────────────────────────────────────────────────────────────
    const commands = new Map<string, Command>();
    try {
      console.log(chalk.blue(`[${sessionName}] Loading commands...`));
      await loadCommands(commandsPath, commands);
      await loadCommands(sessionCommandsPath, commands);

      if (typeof setupGlobalHotReload === "function") {
        setupGlobalHotReload(commands, {
          commands: commandsPath,
          sessionCommands: sessionCommandsPath,
        });
      }

      console.log(chalk.green(`[${sessionName}] Loaded ${commands.size} commands`));
    } catch (error) {
      console.error(chalk.red(`[${sessionName}] Failed to load commands: ${errMsg(error)}`));
    }

    // ── Message handler ───────────────────────────────────────────────────────
    sock.ev.on("messages.upsert", async (m: { messages: string | any[]; }) => {
      try {
        if (!m?.messages?.length) return;

        const msg = m.messages[0];
        if (!msg?.message || msg.key.fromMe === undefined) return;

        const sender = msg.key.participant || msg.key.remoteJid;
        if (!sender || !sock.user) return;

        const user = sock.user as typeof sock.user & { lid?: string };
        const myJid: MyJid = {
          id: user.id.split(":")[0] + "@s.whatsapp.net",
          lid: user.lid ? user.lid.split(":")[0] + "@lid" : null,
        };

        if (!msg.key.fromMe && !(myJid.lid && sender === myJid.lid)) return;

        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          msg.message.videoMessage?.caption ||
          "";

        if (!text?.trim()) return;

        const args = text.trim().split(/ +/);
        const commandName = args.shift()?.toLowerCase();
        if (!commandName) return;

        const command = commands.get(commandName);
        if (!command) return;

        console.log(chalk.blue(`[${sessionName}] Executing: ${chalk.cyan(commandName)}`));

        try {
          await command.execute(
            sock,
            msg,
            args,
            myJid,
            sender,
            activeSessions,
            sessionsToNotReconnect,
            startBotInstance,
            pendingSessions,
            isSessionFolderEmpty
          );
        } catch (error) {
          console.error(chalk.red(`[${sessionName}] ❌ Command "${commandName}" failed: ${errMsg(error)}`));
          if (error instanceof Error) console.error(chalk.red(error.stack));
        }
      } catch (error) {
        console.error(chalk.red(`[${sessionName}] Error processing message: ${errMsg(error)}`));
      }
    });

    return sock;
  } catch (error) {
    console.error(chalk.red(`[${sessionName}] Failed to start bot instance: ${errMsg(error)}`));
    throw error;
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function startSessions(): Promise<void> {
  try {
    console.log(chalk.blueBright("🤖 WhatsApp Multi-Session Bot Manager"));
    console.log(chalk.blueBright("====================================="));

    let sessions: string[] = [];
    try {
      if (fs.existsSync(SESSIONS_DIR)) {
        sessions = fs.readdirSync(SESSIONS_DIR).filter((session) => {
          const sessionPath = path.join(SESSIONS_DIR, session);
          try {
            return fs.statSync(sessionPath).isDirectory() && !isSessionFolderEmpty(sessionPath);
          } catch {
            return false;
          }
        });
      }
    } catch (error) {
      console.error(chalk.red(`Error reading sessions directory: ${errMsg(error)}`));
    }

    console.log(chalk.blueBright("Available sessions:"));
    if (sessions.length > 0) {
      sessions.forEach((session, index) => {
        const status = activeSessions[session] ? chalk.green("(Active)") : chalk.gray("(Inactive)");
        console.log(chalk.cyan(`${index + 1}. ${session} ${status}`));
      });
    } else {
      console.log(chalk.yellow("No existing sessions found."));
    }

    const allChoices = [
      { name: chalk.white("🚀 Run an existing session"), value: "run" },
      { name: chalk.white("🌟 Start all sessions"), value: "all" },
      { name: chalk.white("➕ Create a new session"), value: "new" },
      { name: chalk.white("🗑  Delete a session"), value: "delete" },
      { name: chalk.white("❌ Exit"), value: "exit" },
    ];

    const availableChoices =
      sessions.length > 0
        ? allChoices
        : allChoices.filter((c) => !["run", "delete", "all"].includes(c.value));

    const { action } = await inquirer.prompt<{ action: string }>([
      {
        type: "list",
        name: "action",
        message: chalk.cyan("Choose an option:"),
        choices: availableChoices,
      },
    ]);

    if (action === "exit") {
      console.log(chalk.yellow("Goodbye! 👋"));
      process.exit(0);
    }

    if (action === "delete") {
      const { sessionName } = await inquirer.prompt<{ sessionName: string }>([
        {
          type: "list",
          name: "sessionName",
          message: chalk.red("Select a session to delete:"),
          choices: sessions.map((s) => ({ name: chalk.white(s), value: s })),
        },
      ]);

      const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
        {
          type: "confirm",
          name: "confirm",
          message: chalk.red(`Delete "${sessionName}"? This cannot be undone.`),
          default: false,
        },
      ]);

      if (confirm) {
        try {
          if (activeSessions[sessionName]) {
            activeSessions[sessionName].ev.removeAllListeners("connection.update");
            activeSessions[sessionName].end(undefined);
            delete activeSessions[sessionName];
          }
          const sessionPath = path.join(SESSIONS_DIR, sessionName);
          if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log(chalk.green(`✅ Session "${sessionName}" deleted`));
          }
        } catch (error) {
          console.error(chalk.red(`Failed to delete session: ${errMsg(error)}`));
        }
      } else {
        console.log(chalk.yellow("Deletion cancelled"));
      }

      return startSessions();
    }

    if (action === "all") {
      const valid = sessions.filter((s) => !isSessionFolderEmpty(path.join(SESSIONS_DIR, s)));
      if (valid.length === 0) {
        console.log(chalk.yellow("No valid sessions found. Creating a default session..."));
        await startBotInstance("default");
        return;
      }
      console.log(chalk.green(`Starting ${valid.length} session(s)...`));
      await Promise.allSettled(
        valid.map((session) =>
          activeSessions[session]
            ? (console.log(chalk.yellow(`${session} already active, skipping`)), Promise.resolve())
            : startBotInstance(session).catch((e) =>
                console.error(chalk.red(`Failed to start ${session}: ${errMsg(e)}`))
              )
        )
      );
      return;
    }

    if (action === "new") {
      const { sessionName } = await inquirer.prompt<{ sessionName: string }>([
        {
          type: "input",
          name: "sessionName",
          message: chalk.cyan("Enter a name for the new session:"),
          validate: (input: string) => {
            input = input.trim();
            if (!input) return chalk.red("Session name cannot be empty");
            if (!isValidSessionName(input))
              return chalk.yellow("Use 3-20 characters: letters, numbers, - or _ only.");
            const sessionPath = path.join(SESSIONS_DIR, input);
            if (fs.existsSync(sessionPath) && !isSessionFolderEmpty(sessionPath))
              return chalk.yellow(`Session '${input}' already exists.`);
            return true;
          },
        },
      ]);

      const { authMethod } = await inquirer.prompt<{ authMethod: "qr" | "code" }>([
        {
          type: "list",
          name: "authMethod",
          message: chalk.cyan("Choose authentication method:"),
          choices: [
            { name: chalk.white("📱 QR Code  — scan with WhatsApp camera"), value: "qr" },
            { name: chalk.white("🔢 Pairing Code — enter code in Linked Devices"), value: "code" },
          ],
        },
      ]);

      console.log(chalk.green(`Creating session: ${chalk.cyan(sessionName.trim())} (${authMethod})`));
      await startBotInstance(sessionName.trim(), { authMethod });
      return;
    }

    if (action === "run") {
      if (sessions.length === 0) {
        console.log(chalk.yellow("No sessions available. Creating a default session..."));
        await startBotInstance("default");
        return;
      }

      const { sessionName } = await inquirer.prompt<{ sessionName: string }>([
        {
          type: "list",
          name: "sessionName",
          message: chalk.cyan("Select a session to start:"),
          choices: sessions.map((s) => ({
            name: `${chalk.white(s)} ${activeSessions[s] ? chalk.green("(Active)") : chalk.gray("(Inactive)")}`,
            value: s,
          })),
        },
      ]);

      if (activeSessions[sessionName]) {
        console.log(chalk.yellow(`Session ${sessionName} is already active!`));
      } else {
        console.log(chalk.green(`Starting session: ${chalk.cyan(sessionName)}`));
        await startBotInstance(sessionName);
      }
    }
  } catch (error) {
    if ((error as { isTtyError?: boolean })?.isTtyError) {
      console.error(chalk.red("Terminal doesn't support interactive prompts"));
    } else {
      console.error(chalk.red(`Error in startSessions: ${errMsg(error)}`));
    }
  }
}

// ─── Process events ───────────────────────────────────────────────────────────

process.on("SIGINT", async () => {
  console.log(chalk.yellow("\n🛑 Shutting down..."));
  await Promise.allSettled(
    Object.entries(activeSessions).map(async ([sessionName, sock]) => {
      try {
        console.log(chalk.green(`Closing session: ${chalk.cyan(sessionName)}`));
        sock.ev.removeAllListeners("connection.update");
        sock.end(undefined);
      } catch (error) {
        console.error(chalk.red(`Error closing ${sessionName}: ${errMsg(error)}`));
      }
    })
  );
  console.log(chalk.green("✅ All sessions closed. Goodbye!"));
  process.exit(0);
});

process.on("SIGTERM", () => process.emit("SIGINT", "SIGINT"));

process.on("uncaughtException", (error) => {
  console.error(chalk.red("Uncaught exception:"), error);
  console.error(chalk.red("Stack:"), error.stack);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error(chalk.red("Unhandled rejection at:"), promise, chalk.red("reason:"), reason);
});

// ─── Start ────────────────────────────────────────────────────────────────────

const sessionIdArg = process.env.SESSION_ID || process.argv[2];
const isInteractive = process.stdin.isTTY;

if (sessionIdArg) {
  const authMethod = (process.env.AUTH_METHOD as "qr" | "code" | undefined) || "qr";
  const phoneNumber = process.env.PHONE_NUMBER;

  console.log(chalk.blue(`Starting non-interactive session: ${chalk.cyan(sessionIdArg)} (${authMethod})`));

  startBotInstance(sessionIdArg, { authMethod, phoneNumber }).catch((error) => {
    console.error(chalk.red(`Failed to start ${sessionIdArg}: ${errMsg(error)}`));
    process.exit(1);
  });
} else if (isInteractive) {
  startSessions().catch((error) => {
    console.error(chalk.red(`Failed to start: ${errMsg(error)}`));
    process.exit(1);
  });
} else {
  console.error(chalk.red("No SESSION_ID provided and no TTY available for interactive selection."));
  console.error(
    chalk.yellow(
      "Run with: SESSION_ID=<name> node index.js  (add AUTH_METHOD=code PHONE_NUMBER=... for pairing code)"
    )
  );
  process.exit(1);
}

export {
  startBotInstance,
  isSessionFolderEmpty,
  pendingSessions,
  activeSessions,
  cleanupSession,
};