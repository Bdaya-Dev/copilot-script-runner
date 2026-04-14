import { writeFile, unlink, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join, basename } from 'path';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';

/**
 * Strip ANSI escape sequences and terminal control codes from text.
 * Handles CSI sequences (cursor positioning, colors), OSC sequences
 * (including VS Code shell integration 633), and other control characters
 * that leak from terminal output.
 */
export function stripAnsiEscapes(text: string): string {
  return text
    // OSC sequences: ESC ] ... (BEL | ESC \) - includes VS Code shell integration (633)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    // Incomplete OSC at end of string (partial sequence from chunked reading)
    .replace(/\x1b\][^\x07]*$/g, '')
    // CSI sequences: ESC [ <params> <intermediate> <final byte>
    .replace(/\x1b\[[\d;?]*[A-Za-z]/g, '')
    // Other two-char escape sequences: ESC + single char
    .replace(/\x1b[^[\]]/g, '')
    // Handle \r (carriage return) used for line overwriting: keep text after last \r per line
    .replace(/[^\n]*\r(?!\n)/g, '')
    // Remove remaining non-printable control characters (keep \n, \t)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

export interface ScriptResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  commandId?: string;
  terminalId?: string;
  isBackground?: boolean;
  /** The command string sent to the terminal (for echo stripping) */
  commandText?: string;
}

/**
 * Represents a tracked command execution.
 * Each invocation of runScript produces a unique command.
 */
export interface Command {
  commandId: string;
  terminalId: string;
  execution: vscode.TerminalShellExecution;
  closeOnTimeout: boolean;
  startedAt: number;
  /** Accumulated output from the command so far */
  output: string;
  /** Whether the command stream has finished */
  completed: boolean;
  /** Resolves when the command stream ends */
  completionPromise: Promise<void>;
  /**
   * Resolves when it is safe to dispatch a new command on this terminal.
   *
   * - Normal completion: resolves together with completionPromise.
   * - closeOnTimeout=true timed out: resolves immediately after Ctrl+C so the
   *   terminal can be reused without waiting for the (now-aborted) reader.
   * - closeOnTimeout=false timed out: does NOT resolve until the command ends
   *   naturally — the terminal remains locked to prevent output interleaving.
   */
  reuseGate: Promise<void>;
  /** @internal Resolves reuseGate — called by the background reader or on abort. */
  _resolveReuseGate: () => void;
  /** @internal When true the background reader exits at the next chunk boundary. */
  _readerAborted: boolean;
  /**
   * @internal Set to true by whichever code path releases busyTerminals first.
   * The finally block checks this before deleting so it never incorrectly removes
   * a LATER command's busy entry on the same terminal.
   */
  _busyReleased: boolean;
  /** Path to the temp script file, cleaned up when command completes */
  scriptPath?: string;
  /** Whether to keep the script file after completion */
  keepScript?: boolean;
  /** The command string that was sent to the terminal (used to strip echo from output) */
  commandText: string;
  /** The real shell exit code, populated by onDidEndTerminalShellExecution */
  exitCode?: number;
}

/**
 * Shell types that we can detect and handle.
 * Based on VS Code's TerminalShellType from terminal.ts
 */
export enum ShellType {
  PowerShell = 'pwsh',
  Bash = 'bash',
  Zsh = 'zsh',
  Fish = 'fish',
  Cmd = 'cmd',
  Wsl = 'wsl',
  GitBash = 'gitbash',
  Unknown = 'unknown'
}

/**
 * Detect shell type from an executable path.
 * Based on VS Code's shell detection in windowsShellHelper.ts and runInTerminalHelpers.ts
 */
export function detectShellType(shellPath: string): ShellType {
  const executable = basename(shellPath).toLowerCase().replace(/\.exe$/i, '');

  // PowerShell variants
  if (/^(?:powershell|pwsh)(?:-preview)?$/.test(executable)) {
    return ShellType.PowerShell;
  }

  // Bash (including Git Bash which uses bash.exe)
  if (executable === 'bash') {
    // Check if it's Git Bash by path
    if (shellPath.toLowerCase().includes('\\git\\')) {
      return ShellType.GitBash;
    }
    return ShellType.Bash;
  }

  // WSL
  if (executable === 'wsl' || executable === 'ubuntu' || executable === 'debian' ||
    executable === 'kali' || executable === 'opensuse-42' || executable === 'sles-12') {
    return ShellType.Wsl;
  }

  // Other shells
  if (executable === 'zsh') return ShellType.Zsh;
  if (executable === 'fish') return ShellType.Fish;
  if (executable === 'cmd') return ShellType.Cmd;

  return ShellType.Unknown;
}

/**
 * Get the current shell type from VS Code's default shell setting
 */
export function getDefaultShellType(): ShellType {
  const shell = vscode.env.shell;
  if (!shell) {
    return process.platform === 'win32' ? ShellType.PowerShell : ShellType.Bash;
  }
  return detectShellType(shell);
}

// Store active terminals for background process tracking
const activeTerminals = new Map<string, vscode.Terminal>();

// Track which terminals are currently busy executing a command
const busyTerminals = new Set<string>();

// Terminals eligible for auto-selection pool (only auto-created ones, not explicitly named ones).
// Explicitly named terminals (created via targetTerminalId) are reserved and should only be
// reused when the caller provides that same ID — they must never be hijacked by the
// auto-selector, even if idle.
const pooledTerminals = new Set<string>();

// Store tracked commands by commandId
const commands = new Map<string, Command>();

// Index from TerminalShellExecution → commandId for O(1) exit-code lookup.
// Populated when a command is registered; cleaned up by evictStaleCommands.
const executionToCommandId = new Map<vscode.TerminalShellExecution, string>();

// Listen for shell execution end events to capture the real exit code.
// This is registered once at module load and covers all commands.
vscode.window.onDidEndTerminalShellExecution(e => {
  const commandId = executionToCommandId.get(e.execution);
  if (commandId) {
    const cmd = commands.get(commandId);
    if (cmd) {
      cmd.exitCode = e.exitCode;
    }
  }
});

/** Max age for completed commands before they are evicted (30 minutes) */
const COMMAND_TTL_MS = 30 * 60 * 1000;

/**
 * Get a tracked command by its command ID
 */
export function getCommand(commandId: string): Command | undefined {
  return commands.get(commandId);
}

/**
 * Generate a unique command ID
 */
export function generateCommandId(): string {
  return `cmd-${randomUUID().substring(0, 8)}`;
}

/**
 * Strip ANSI escapes AND the command echo from terminal output.
 *
 * onDidWriteTerminalData captures all raw terminal data including the echoed
 * command line. Stripping the echo prevents the invocation command from
 * appearing in the returned output.
 */
export function cleanOutput(rawOutput: string, commandText?: string): string {
  let cleaned = stripAnsiEscapes(rawOutput);

  if (commandText) {
    const cmdTrimmed = commandText.trim();
    const idx = cleaned.indexOf(cmdTrimmed);
    // Only strip when found near the beginning (< 500 chars handles long
    // commands or prompt prefixes without matching a later occurrence in the
    // actual script output).
    if (idx !== -1 && idx < 500) {
      cleaned = cleaned.substring(idx + cmdTrimmed.length).replace(/^\r?\n/, '');
    }
  }

  return cleaned.trim();
}

/**
 * Get the most recent command tracked for a terminal.
 */
export function getLastCommandForTerminal(terminalId: string): Command | undefined {
  let latest: Command | undefined;
  for (const cmd of commands.values()) {
    if (cmd.terminalId === terminalId && (!latest || cmd.startedAt > latest.startedAt)) {
      latest = cmd;
    }
  }
  return latest;
}

/**
 * Evict completed commands older than COMMAND_TTL_MS to prevent unbounded growth.
 */
function evictStaleCommands(): void {
  const now = Date.now();
  for (const [id, cmd] of commands) {
    if (cmd.completed && now - cmd.startedAt > COMMAND_TTL_MS) {      executionToCommandId.delete(cmd.execution);      commands.delete(id);
    }
  }
}

/**
 * Find an existing idle Script Runner terminal from the auto-selection pool.
 * Only terminals that were originally created without an explicit terminalId are
 * eligible — explicitly named terminals are reserved for direct targeting only.
 * If workingDirectory is specified, only returns a terminal whose current
 * working directory matches (via shell integration cwd).
 */
function findIdleTerminal(terminalNamePrefix: string, workingDirectory?: string): { terminal: vscode.Terminal; terminalId: string } | undefined {
  for (const [terminalId, terminal] of activeTerminals) {
    // Only consider pooled (auto-created) terminals, and skip busy ones
    if (!pooledTerminals.has(terminalId) || busyTerminals.has(terminalId)) {
      continue;
    }
    // Name prefix still acts as a secondary guard (shell-type match)
    if (!terminal.name.startsWith(terminalNamePrefix)) {
      continue;
    }

    // If a specific working directory is requested, only reuse terminals that match
    if (workingDirectory) {
      const terminalCwd = terminal.shellIntegration?.cwd?.fsPath;
      if (!terminalCwd || normalizePath(terminalCwd) !== normalizePath(workingDirectory)) {
        continue;
      }
    }

    return { terminal, terminalId };
  }
  return undefined;
}

/**
 * Normalize a file path for comparison (lowercase on Windows, consistent separators)
 */
function normalizePath(p: string): string {
  const normalized = p.replace(/\\/g, '/').replace(/\/$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * Get or create the temp directory for scripts
 */
export async function getTempDir(): Promise<string> {
  const tempDir = join(tmpdir(), 'script-runner-extension');
  await mkdir(tempDir, { recursive: true });
  return tempDir;
}

/**
 * Generate a unique script file path
 */
export function generateScriptPath(tempDir: string, extension: string): string {
  const scriptId = randomUUID().substring(0, 8);
  return join(tempDir, `script-${scriptId}${extension}`);
}

/**
 * Generate a unique terminal ID
 */
export function generateTerminalId(): string {
  return randomUUID().substring(0, 8);
}

/**
 * Get a terminal by ID
 */
export function getTerminalById(id: string): vscode.Terminal | undefined {
  return activeTerminals.get(id);
}

/**
 * Wait for shell integration to be available on a terminal.
 *
 * Mirrors the VS Code internal pattern (terminalInstance.ts runCommand):
 * - Race between the integration event, a timeout, and terminal disposal
 * - Dispose all listeners on resolution to prevent leaks
 */
async function waitForShellIntegration(
  terminal: vscode.Terminal,
  token?: vscode.CancellationToken,
  timeoutMs: number = 15_000
): Promise<void> {
  // Already available
  if (terminal.shellIntegration) {
    return;
  }

  return new Promise<void>((resolve, reject) => {
    const disposables: vscode.Disposable[] = [];

    const cleanup = () => {
      for (const d of disposables) {
        d.dispose();
      }
    };

    // Shell integration activated
    disposables.push(
      vscode.window.onDidChangeTerminalShellIntegration((e) => {
        if (e.terminal === terminal) {
          cleanup();
          resolve();
        }
      })
    );

    // Terminal closed before integration was ready
    disposables.push(
      vscode.window.onDidCloseTerminal((t) => {
        if (t === terminal) {
          cleanup();
          reject(new Error('Terminal closed before shell integration was available'));
        }
      })
    );

    // Cancellation token
    if (token) {
      disposables.push(
        token.onCancellationRequested(() => {
          cleanup();
          reject(new Error('Cancelled while waiting for shell integration'));
        })
      );
    }

    // Timeout fallback — VS Code always pairs this wait with a timeout
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Shell integration did not activate within ${timeoutMs / 1000}s. Ensure terminal.integrated.shellIntegration.enabled is true.`));
    }, timeoutMs);
    disposables.push({ dispose: () => clearTimeout(timer) });
  });
}

/**
 * Execute a command in VS Code terminal with shell integration.
 * 
 * Reuses existing idle terminals when available to avoid spawning new ones.
 * 
 * Note: We cannot detect alternate buffer mode from the extension API since
 * xterm.raw.buffer.onBufferChange is not exposed. The built-in run_in_terminal
 * tool has internal access to xterm APIs that we don't have.
 * 
 * Our approach:
 * - For background mode: Return immediately with terminal ID
 * - For foreground mode: Collect output with timeout, let VS Code's shell
 *   integration handle the execution lifecycle
 */
export async function executeInTerminal(
  command: string,
  terminalName: string = 'Script Runner',
  isBackground: boolean = false,
  timeoutMs?: number,
  closeOnTimeout: boolean = false,
  scriptPath?: string,
  keepScript: boolean = false,
  workingDirectory?: string,
  targetTerminalId?: string,
  token?: vscode.CancellationToken
): Promise<ScriptResult> {
  let terminal: vscode.Terminal;
  let terminalId: string;
  let isNewTerminal = false;

  if (targetTerminalId) {
    // Target a specific terminal by ID, creating it if it doesn't exist
    const existingTerminal = activeTerminals.get(targetTerminalId);
    if (existingTerminal) {
      terminal = existingTerminal;
      terminalId = targetTerminalId;
    } else {
      terminalId = targetTerminalId;
      terminal = vscode.window.createTerminal({
        name: `${terminalName} (${terminalId})`,
        cwd: workingDirectory,
      });
      isNewTerminal = true;

      // Explicitly named terminal — add to activeTerminals but NOT to pooledTerminals
      // so the auto-selector never steals it
      activeTerminals.set(terminalId, terminal);

      const disposeListener = vscode.window.onDidCloseTerminal((t) => {
        if (t === terminal) {
          activeTerminals.delete(terminalId);
          busyTerminals.delete(terminalId);
          disposeListener.dispose();
        }
      });
    }
  } else {
    // Try to find an existing idle terminal first (matching workingDirectory if specified)
    const existing = findIdleTerminal(terminalName, workingDirectory);
    if (existing) {
      terminal = existing.terminal;
      terminalId = existing.terminalId;
    } else {
      // Create a new terminal if no idle one is available
      terminalId = generateTerminalId();
      terminal = vscode.window.createTerminal({
        name: `${terminalName} (${terminalId})`,
        cwd: workingDirectory,
      });
      isNewTerminal = true;

      // Store terminal in both the active map and the auto-select pool
      activeTerminals.set(terminalId, terminal);
      pooledTerminals.add(terminalId);

      // Clean up when terminal is closed
      const disposeListener = vscode.window.onDidCloseTerminal((t) => {
        if (t === terminal) {
          activeTerminals.delete(terminalId);
          busyTerminals.delete(terminalId);
          pooledTerminals.delete(terminalId);
          disposeListener.dispose();
        }
      });
    }
  }

  // Mark terminal as busy
  busyTerminals.add(terminalId);

  // Evict old completed commands to prevent unbounded Map growth
  evictStaleCommands();

  try {
    if (isNewTerminal) {
      // New terminal: wait for shell integration to activate
      await waitForShellIntegration(terminal, token);
    } else {
      // Reused terminal: wait until the previous command's terminal slot is free.
      // reuseGate resolves when the stream ends naturally OR when a timed-out
      // command is explicitly interrupted (closeOnTimeout=true).  For timed-out
      // commands still running in the background it stays pending, keeping the
      // terminal locked to prevent output interleaving.
      const lastCmd = getLastCommandForTerminal(terminalId);
      if (lastCmd && !lastCmd.completed) {
        await lastCmd.reuseGate;
      }
    }
  } catch (e) {
    busyTerminals.delete(terminalId);
    return {
      stdout: '',
      stderr: (e as Error).message,
      exitCode: 1,
      terminalId
    };
  }

  // Fix C: guard against shellIntegration disappearing between the wait and the execute
  if (!terminal.shellIntegration) {
    busyTerminals.delete(terminalId);
    return {
      stdout: '',
      stderr: 'Shell integration is not available on this terminal. Ensure terminal.integrated.shellIntegration.enabled is true.',
      exitCode: 1,
      terminalId
    };
  }

  const execution = terminal.shellIntegration.executeCommand(command);
  const commandId = generateCommandId();

  // Track command with background output collection
  let _resolveReuseGate!: () => void;
  const reuseGate = new Promise<void>(resolve => { _resolveReuseGate = resolve; });

  const cmd: Command = {
    commandId,
    terminalId,
    execution,
    closeOnTimeout,
    startedAt: Date.now(),
    output: '',
    completed: false,
    completionPromise: Promise.resolve(),
    reuseGate,
    _resolveReuseGate,
    _readerAborted: false,
    _busyReleased: false,
    scriptPath,
    keepScript,
    commandText: command
  };
  // Start background output capture via onDidWriteTerminalData.
  // This replaces execution.read() which suffers from a VS Code bug where
  // native commands (git, cmd, etc.) cause the AsyncIterable to terminate
  // prematurely, losing all subsequent output. onDidWriteTerminalData fires
  // independently of shell integration lifecycle and captures ALL terminal data.
  // See: https://github.com/microsoft/vscode/issues/297109
  let rawOutput = '';
  cmd.completionPromise = new Promise<void>(resolveCompletion => {
    let cleanedUp = false;
    function cleanup() {
      if (cleanedUp) { return; }
      cleanedUp = true;
      dataListener.dispose();
      closeListener.dispose();
      endListener.dispose();
      cmd.output = rawOutput;
      cmd.completed = true;
      _resolveReuseGate();
      if (!cmd._busyReleased) {
        cmd._busyReleased = true;
        busyTerminals.delete(terminalId);
      }
      if (cmd.scriptPath && !cmd.keepScript) {
        cleanupScriptFile(cmd.scriptPath).catch(() => { });
      }
      resolveCompletion();
    }

    const dataListener = vscode.window.onDidWriteTerminalData(e => {
      if (e.terminal !== terminal || cmd._readerAborted) { return; }
      rawOutput += e.data;
    });

    // Safety net: if the terminal is closed before the execution ends,
    // clean up immediately to avoid leaked listeners and a stuck promise.
    const closeListener = vscode.window.onDidCloseTerminal(t => {
      if (t === terminal) { cleanup(); }
    });

    // Use onDidEndTerminalShellExecution as completion signal with a delay
    // to let any remaining onDidWriteTerminalData events arrive.
    const endListener = vscode.window.onDidEndTerminalShellExecution(e => {
      if (e.execution !== execution) { return; }
      endListener.dispose();
      setTimeout(cleanup, 200);
    });
  });
  commands.set(commandId, cmd);
  executionToCommandId.set(execution, commandId);

  // For background processes, return immediately
  if (isBackground) {
    return {
      stdout: `Background process started. Command ID: ${commandId}. Use #getScriptOutput with the command ID to check output later.`,
      stderr: '',
      exitCode: 0,
      commandId,
      terminalId,
      isBackground: true
    };
  }

  // For foreground processes, race cmd.completionPromise (the single background reader)
  // against an optional timeout. Using cmd.output as the sole output source ensures the
  // foreground and background views are identical — Fix D.
  let result: 'complete' | 'error' | 'timeout';

  if (timeoutMs !== undefined) {
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), timeoutMs);
    });
    result = await Promise.race([
      cmd.completionPromise.then(() => 'complete' as const).catch(() => 'error' as const),
      timeoutPromise
    ]);
  } else {
    result = await cmd.completionPromise.then(() => 'complete' as const).catch(() => 'error' as const);
  }

  if (result === 'timeout') {
    if (closeOnTimeout) {
      // Send Ctrl+C (SIGINT) to interrupt the running command, then abort the
      // background reader and immediately release the terminal for reuse.
      terminal.sendText('\x03', false);
      cmd._readerAborted = true;
      // Mark as released first so the finally block skips the delete entirely,
      // preventing it from later removing a different command's busy entry.
      cmd._busyReleased = true;
      busyTerminals.delete(terminalId);
      _resolveReuseGate();
    }
    // When closeOnTimeout=false the command is still running in the terminal.
    // Leave busyTerminals intact — the background reader's finally block will
    // call busyTerminals.delete + _resolveReuseGate when the command ends.
    return {
      stdout: cmd.output + '\n\n[Output truncated - command timed out or is still running.' + (closeOnTimeout ? ' Command was interrupted (Ctrl+C).' : '') + ' Command ID: ' + commandId + ']',
      stderr: '',
      exitCode: closeOnTimeout ? 1 : 0,
      commandId,
      terminalId,
      commandText: command
    };
  }

  // Normal/error completion — the finally block already released busyTerminals
  // (it runs synchronously before completionPromise resolves) and resolved
  // reuseGate.  Any code awaiting reuseGate is queued as a microtask and will
  // call busyTerminals.add() for the next command before this point is reached,
  // so a redundant delete here would incorrectly remove that new entry.
  return {
    stdout: cmd.output,
    stderr: '',
    exitCode: cmd.exitCode ?? 0,
    commandId,
    terminalId,
    commandText: command
  };
}

/**
 * Build the command to execute a script based on the shell type.
 * 
 * This handles the differences between shells:
 * - PowerShell: Runs script via & operator with Out-Host for streaming display
 * - Bash/Zsh: Uses 2>&1 to merge stderr into stdout
 * - Fish: Uses 2>&1 redirection
 * - CMD: Uses 2>&1 redirection
 * 
 * @param scriptPath - Path to the script file
 * @param shellType - The shell type to format the command for
 * @param executingFromShell - The shell that will run this command (for nested execution like Git Bash from PowerShell)
 */
export function buildScriptCommand(scriptPath: string, shellType: ShellType, executingFromShell?: ShellType): string {
  switch (shellType) {
    case ShellType.PowerShell:
      // Run script via & (call operator) which executes the quoted path.
      // & is required because the path is in quotes (for spaces in temp dirs);
      // without it PowerShell just prints the string literal.
      // exit $LASTEXITCODE propagates the script's exit code to the shell,
      // which becomes the 633;D exit code for onDidEndTerminalShellExecution.
      // No | Out-Host needed — output goes to terminal directly.
      // No 2>&1 needed — in a PTY both stdout and stderr go to the same stream.
      return `& '${scriptPath.replace(/'/g, "''")}'; exit $LASTEXITCODE`;

    case ShellType.Bash:
    case ShellType.Zsh:
      // Simple bash execution with stderr redirect
      return `bash "${scriptPath}" 2>&1`;

    case ShellType.Fish:
      return `fish "${scriptPath}" 2>&1`;

    case ShellType.Wsl:
      // Convert Windows path to WSL path and execute inside WSL
      const wslPath = scriptPath
        .replace(/\\/g, '/')
        .replace(/^([A-Z]):/, (_, letter: string) => `/mnt/${letter.toLowerCase()}`);
      // Run inside WSL's bash context
      return `wsl bash -c 'bash "${wslPath}" 2>&1'`;

    case ShellType.GitBash:
      // Convert backslashes to forward slashes for Git Bash
      const gitBashPath = scriptPath.replace(/\\/g, '/');
      // If executing from PowerShell, we need the & operator and full path
      if (executingFromShell === ShellType.PowerShell) {
        return `& "$env:ProgramFiles\\Git\\bin\\bash.exe" -c 'bash "${gitBashPath}" 2>&1'`;
      }
      // If already in Git Bash context
      return `bash "${gitBashPath}" 2>&1`;

    case ShellType.Cmd:
      return `cmd /c "${scriptPath}" 2>&1`;

    default:
      // Fallback: try bash-style execution
      return `bash "${scriptPath}" 2>&1`;
  }
}

/**
 * Get the appropriate script file extension for a shell type
 */
export function getScriptExtension(shellType: ShellType): string {
  switch (shellType) {
    case ShellType.PowerShell:
      return '.ps1';
    case ShellType.Cmd:
      return '.cmd';
    case ShellType.Fish:
      return '.fish';
    case ShellType.Bash:
    case ShellType.Zsh:
    case ShellType.Wsl:
    case ShellType.GitBash:
    default:
      return '.sh';
  }
}

/**
 * Execute a script in VS Code's terminal using the appropriate shell.
 * 
 * This is the main entry point for script execution. It:
 * 1. Detects the current shell type from VS Code's default shell
 * 2. Builds the appropriate command for that shell
 * 3. Executes the command via shell integration
 * 
 * @param scriptPath - Path to the script file
 * @param shellType - The shell type to use (defaults to auto-detected)
 * @param timeoutMs - Optional timeout in milliseconds
 * @param isBackground - Whether to run in background mode
 */
export async function executeScript(
  scriptPath: string,
  shellType?: ShellType,
  timeoutMs?: number,
  isBackground: boolean = false,
  closeOnTimeout: boolean = false,
  keepScript: boolean = false,
  workingDirectory?: string,
  targetTerminalId?: string,
  token?: vscode.CancellationToken
): Promise<ScriptResult> {
  const effectiveShellType = shellType ?? getDefaultShellType();
  const terminalName = `Script Runner (${effectiveShellType})`;

  // Build the command for this shell type
  // When running in VS Code terminal, the "executing from" shell is the VS Code default shell
  const executingFromShell = getDefaultShellType();
  const command = buildScriptCommand(scriptPath, effectiveShellType, executingFromShell);

  return executeInTerminal(command, terminalName, isBackground, timeoutMs, closeOnTimeout, scriptPath, keepScript, workingDirectory, targetTerminalId, token);
}

/**
/**
 * Execute a PowerShell script file in VS Code terminal.
 */
export async function executePowerShellScript(
  scriptPath: string,
  workingDirectory?: string,
  timeoutMs?: number,
  isBackground: boolean = false
): Promise<ScriptResult> {
  return executeScript(scriptPath, ShellType.PowerShell, timeoutMs, isBackground, false, false, workingDirectory);
}

/**
 * Execute a Bash script file via WSL in VS Code terminal.
 * 
 * The redirection must happen INSIDE WSL, not in PowerShell, because:
 * - PowerShell interprets `| cat` as its own Get-Content alias
 * - We use wsl bash -c '...' to run the entire command in bash context
 * 
 * @see https://www.gnu.org/software/bash/manual/html_node/Redirections.html
 */
export async function executeWslScript(
  scriptPath: string,
  workingDirectory?: string,
  timeoutMs?: number,
  isBackground: boolean = false
): Promise<ScriptResult> {
  return executeScript(scriptPath, ShellType.Wsl, timeoutMs, isBackground, false, false, workingDirectory);
}

/**
 * Execute a Bash script file via Git Bash in VS Code terminal.
 * 
 * The script is wrapped to handle stderr redirection and execute
 * within the bash context (not PowerShell's redirection).
 * 
 * @see https://www.gnu.org/software/bash/manual/html_node/Redirections.html
 */
export async function executeGitBashScript(
  scriptPath: string,
  workingDirectory?: string,
  timeoutMs?: number,
  isBackground: boolean = false
): Promise<ScriptResult> {
  return executeScript(scriptPath, ShellType.GitBash, timeoutMs, isBackground, false, false, workingDirectory);
}

/**
 * Execute a Bash script file directly (native Linux/macOS).
 * 
 * Use this on Linux/macOS remotes or when running in a native bash environment.
 */
export async function executeBashScript(
  scriptPath: string,
  workingDirectory?: string,
  timeoutMs?: number,
  isBackground: boolean = false
): Promise<ScriptResult> {
  return executeScript(scriptPath, ShellType.Bash, timeoutMs, isBackground, false, false, workingDirectory);
}

/**
 * Write script content to a file
 */
export async function writeScriptFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, 'utf-8');
}

/**
 * Clean up script file
 */
export async function cleanupScriptFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Format the script output for the tool result
 */
export function formatOutput(result: ScriptResult, keepScript: boolean, scriptPath?: string): string {
  const output: string[] = [];

  if (result.isBackground) {
    output.push(`Background process started.`);
    output.push(`Terminal ID: ${result.terminalId}`);
    output.push(`Command ID: ${result.commandId}`);
    output.push(`Use #getScriptOutput with the command ID to check output later.`);
    return output.join('\n');
  }

  if (result.stdout) {
    output.push(`STDOUT:\n${cleanOutput(result.stdout, result.commandText)}`);
  }
  if (result.stderr) {
    output.push(`STDERR:\n${stripAnsiEscapes(result.stderr)}`);
  }
  output.push(`\nExit Code: ${result.exitCode}`);

  if (result.commandId) {
    output.push(`Command ID: ${result.commandId}`);
  }

  if (result.terminalId) {
    output.push(`Terminal ID: ${result.terminalId}`);
  }

  if (keepScript && scriptPath) {
    output.push(`Script saved at: ${scriptPath}`);
  }

  return output.join('\n') || '(no output)';
}

/**
 * Get all active terminals with their metadata
 */
export function getAllTerminals(): { terminalId: string; name: string; isBusy: boolean; cwd?: string }[] {
  const result: { terminalId: string; name: string; isBusy: boolean; cwd?: string }[] = [];
  for (const [terminalId, terminal] of activeTerminals) {
    result.push({
      terminalId,
      name: terminal.name,
      isBusy: busyTerminals.has(terminalId),
      cwd: terminal.shellIntegration?.cwd?.fsPath
    });
  }
  return result;
}

/**
 * Get all commands for a specific terminal
 */
export function getCommandsForTerminal(terminalId: string): Command[] {
  const result: Command[] = [];
  for (const cmd of commands.values()) {
    if (cmd.terminalId === terminalId) {
      result.push(cmd);
    }
  }
  return result;
}

/**
 * Get all tracked commands
 */
export function getAllCommands(): Map<string, Command> {
  return new Map(commands);
}

/**
 * Check if a terminal is busy
 */
export function isTerminalBusy(terminalId: string): boolean {
  return busyTerminals.has(terminalId);
}

/**
 * Close a terminal by ID
 */
export function closeTerminalById(terminalId: string): boolean {
  const terminal = activeTerminals.get(terminalId);
  if (terminal) {
    terminal.dispose();
    activeTerminals.delete(terminalId);
    busyTerminals.delete(terminalId);
    pooledTerminals.delete(terminalId);
    return true;
  }
  return false;
}

/**
 * Send raw text to a terminal (does not press enter unless text includes \\n)
 */
export function sendTextToTerminal(terminalId: string, text: string, addNewline: boolean = false): boolean {
  const terminal = activeTerminals.get(terminalId);
  if (terminal) {
    terminal.sendText(text, addNewline);
    return true;
  }
  return false;
}

/**
 * Send Ctrl+C (SIGINT) to interrupt the running process in a terminal
 */
export function interruptTerminal(terminalId: string): boolean {
  return sendTextToTerminal(terminalId, '\x03', false);
}
