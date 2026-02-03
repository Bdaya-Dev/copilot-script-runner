import { writeFile, unlink, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join, basename } from 'path';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';

export interface ScriptResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    terminalId?: string;
    isBackground?: boolean;
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

// Store the last execution for each terminal (for getScriptOutput)
const lastExecutions = new Map<string, vscode.TerminalShellExecution>();

/**
 * Get the last execution for a terminal by ID
 */
export function getLastExecution(terminalId: string): vscode.TerminalShellExecution | undefined {
    return lastExecutions.get(terminalId);
}

/**
 * Find an existing idle Script Runner terminal or return undefined
 */
function findIdleTerminal(terminalNamePrefix: string): { terminal: vscode.Terminal; terminalId: string } | undefined {
    for (const [terminalId, terminal] of activeTerminals) {
        // Check if this terminal matches our prefix and is not busy
        if (terminal.name.startsWith(terminalNamePrefix) && !busyTerminals.has(terminalId)) {
            return { terminal, terminalId };
        }
    }
    return undefined;
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
 * Wait for shell integration to be available on a terminal
 */
async function waitForShellIntegration(terminal: vscode.Terminal): Promise<void> {
    // Already available
    if (terminal.shellIntegration) {
        return;
    }
    
    // Wait for it to become available
    return new Promise<void>((resolve) => {
        const disposable = vscode.window.onDidChangeTerminalShellIntegration((e) => {
            if (e.terminal === terminal) {
                disposable.dispose();
                resolve();
            }
        });
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
    timeoutMs?: number
): Promise<ScriptResult> {
    let terminal: vscode.Terminal;
    let terminalId: string;
    let isNewTerminal = false;
    
    // Try to find an existing idle terminal first
    const existing = findIdleTerminal(terminalName);
    if (existing) {
        terminal = existing.terminal;
        terminalId = existing.terminalId;
    } else {
        // Create a new terminal if no idle one is available
        terminalId = generateTerminalId();
        terminal = vscode.window.createTerminal({
            name: `${terminalName} (${terminalId})`,
            isTransient: false
        });
        isNewTerminal = true;
        
        // Store terminal for tracking
        activeTerminals.set(terminalId, terminal);
        
        // Clean up when terminal is closed
        const disposeListener = vscode.window.onDidCloseTerminal((t) => {
            if (t === terminal) {
                activeTerminals.delete(terminalId);
                busyTerminals.delete(terminalId);
                disposeListener.dispose();
            }
        });
    }
    
    terminal.show();
    
    // Mark terminal as busy
    busyTerminals.add(terminalId);

    try {
        // Only wait for shell integration on new terminals
        if (isNewTerminal) {
            await waitForShellIntegration(terminal);
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

    const execution = terminal.shellIntegration!.executeCommand(command);
    
    // Store the execution for later retrieval via getScriptOutput
    lastExecutions.set(terminalId, execution);
    
    // For background processes, return immediately
    if (isBackground) {
        return {
            stdout: `Background process started in terminal ${terminalId}. Use #getScriptOutput with this ID to check output later.`,
            stderr: '',
            exitCode: 0,
            terminalId,
            isBackground: true
        };
    }
    
    // For foreground processes, collect output with optional timeout handling
    // The shell integration stream will complete when the command finishes
    const stream = execution.read();
    let output = '';
    
    const outputPromise = (async () => {
        try {
            for await (const chunk of stream) {
                output += chunk;
            }
            return 'complete' as const;
        } catch {
            return 'error' as const;
        }
    })();
    
    let result: 'complete' | 'error' | 'timeout';
    
    if (timeoutMs !== undefined) {
        const timeoutPromise = new Promise<'timeout'>((resolve) => {
            setTimeout(() => resolve('timeout'), timeoutMs);
        });
        result = await Promise.race([outputPromise, timeoutPromise]);
    } else {
        result = await outputPromise;
    }
    
    // Mark terminal as idle again
    busyTerminals.delete(terminalId);
    
    if (result === 'timeout') {
        return {
            stdout: output + '\n\n[Output truncated - command timed out or is still running. Terminal ID: ' + terminalId + ']',
            stderr: '',
            exitCode: 0,
            terminalId
        };
    }

    return {
        stdout: output,
        stderr: '',
        exitCode: 0,
        terminalId
    };
}

/**
 * Build the command to execute a script based on the shell type.
 * 
 * This handles the differences between shells:
 * - PowerShell: Uses *>&1 to merge streams and Out-Host for streaming output
 * - Bash/Zsh: Uses 2>&1 to merge stderr into stdout
 * - Fish: Uses 2>&1 redirection
 * - CMD: Uses 2>&1 redirection
 * 
 * Note: Out-Host is preferred over Out-String because:
 * - Out-Host streams output in real-time as commands execute
 * - Out-String buffers all output until complete, blocking progress display
 * - Out-Host allows Write-Progress and other progress indicators to work correctly
 * 
 * @param scriptPath - Path to the script file
 * @param shellType - The shell type to format the command for
 * @param executingFromShell - The shell that will run this command (for nested execution like Git Bash from PowerShell)
 */
export function buildScriptCommand(scriptPath: string, shellType: ShellType, executingFromShell?: ShellType): string {
    switch (shellType) {
        case ShellType.PowerShell:
            // *>&1 merges all PowerShell streams into stdout, Out-Host streams output in real-time
            return `pwsh -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" *>&1 | Out-Host`;
        
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
    isBackground: boolean = false
): Promise<ScriptResult> {
    const effectiveShellType = shellType ?? getDefaultShellType();
    const terminalName = `Script Runner (${effectiveShellType})`;
    
    // Build the command for this shell type
    // When running in VS Code terminal, the "executing from" shell is the VS Code default shell
    const executingFromShell = getDefaultShellType();
    const command = buildScriptCommand(scriptPath, effectiveShellType, executingFromShell);
    
    return executeInTerminal(command, terminalName, isBackground, timeoutMs);
}

/**
 * Execute a PowerShell script file in VS Code terminal.
 * 
 * Uses *>&1 to merge all PowerShell streams (Error, Warning, Verbose, Debug, Info)
 * into the Success stream, then pipes through Out-Host for real-time streaming output.
 * This ensures all output including errors is displayed as it's generated.
 * 
 * Out-Host is preferred over Out-String because it:
 * - Streams output in real-time rather than buffering until complete
 * - Allows Write-Progress and progress bars to display correctly
 * - Doesn't block waiting for all input before producing output
 * 
 * @see https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_redirection
 */
export async function executePowerShellScript(
    scriptPath: string,
    _workingDirectory?: string,
    timeoutMs?: number,
    isBackground: boolean = false
): Promise<ScriptResult> {
    return executeScript(scriptPath, ShellType.PowerShell, timeoutMs, isBackground);
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
    _workingDirectory?: string,
    timeoutMs?: number,
    isBackground: boolean = false
): Promise<ScriptResult> {
    return executeScript(scriptPath, ShellType.Wsl, timeoutMs, isBackground);
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
    _workingDirectory?: string,
    timeoutMs?: number,
    isBackground: boolean = false
): Promise<ScriptResult> {
    return executeScript(scriptPath, ShellType.GitBash, timeoutMs, isBackground);
}

/**
 * Execute a Bash script file directly (native Linux/macOS).
 * 
 * Use this on Linux/macOS remotes or when running in a native bash environment.
 */
export async function executeBashScript(
    scriptPath: string,
    _workingDirectory?: string,
    timeoutMs?: number,
    isBackground: boolean = false
): Promise<ScriptResult> {
    return executeScript(scriptPath, ShellType.Bash, timeoutMs, isBackground);
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
        output.push(`Use #getScriptOutput with this ID to check output later.`);
        return output.join('\n');
    }
    
    if (result.stdout) {
        output.push(`STDOUT:\n${result.stdout}`);
    }
    if (result.stderr) {
        output.push(`STDERR:\n${result.stderr}`);
    }
    output.push(`\nExit Code: ${result.exitCode}`);
    
    if (result.terminalId) {
        output.push(`Terminal ID: ${result.terminalId}`);
    }
    
    if (keepScript && scriptPath) {
        output.push(`Script saved at: ${scriptPath}`);
    }
    
    return output.join('\n') || '(no output)';
}
