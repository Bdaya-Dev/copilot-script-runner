import { writeFile, unlink, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';

export interface ScriptResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    terminalId?: string;
    isBackground?: boolean;
}

// Store active terminals for background process tracking
const activeTerminals = new Map<string, vscode.Terminal>();

// Track which terminals are currently busy executing a command
const busyTerminals = new Set<string>();

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

    // DEBUG: Log the command being executed
    console.log('[Script Runner] Executing command:', command);

    const execution = terminal.shellIntegration!.executeCommand(command);
    
    // For background processes, return immediately
    if (isBackground) {
        return {
            stdout: `Background process started in terminal ${terminalId}. Use get_terminal_output with this ID to check output later.`,
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
 * Execute a PowerShell script file in VS Code terminal.
 * 
 * Uses *>&1 to merge all PowerShell streams (Error, Warning, Verbose, Debug, Info)
 * into the Success stream, then pipes through Out-String to convert objects to text.
 * This ensures all output including errors is captured as text.
 * 
 * @see https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_redirection
 */
export async function executePowerShellScript(
    scriptPath: string,
    _workingDirectory?: string,
    timeoutMs?: number,
    isBackground: boolean = false
): Promise<ScriptResult> {
    // *>&1 merges all streams (stdout=1, stderr=2, warning=3, verbose=4, debug=5, info=6) into stdout
    // Out-String converts objects to string representation with specified width
    const command = `pwsh -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" *>&1 | Out-String -Width 4096`;
    return executeInTerminal(command, 'Script Runner (PowerShell)', isBackground, timeoutMs);
}

/**
 * Execute a Bash script file via WSL in VS Code terminal.
 * 
 * Uses 2>&1 to redirect stderr to stdout, then pipes through cat to:
 * 1. Prevent any pager (less, more) from activating
 * 2. Ensure output flows continuously without alternate buffer
 * 
 * @see https://www.gnu.org/software/bash/manual/html_node/Redirections.html
 */
export async function executeWslScript(
    scriptPath: string,
    _workingDirectory?: string,
    timeoutMs?: number,
    isBackground: boolean = false
): Promise<ScriptResult> {
    // Convert Windows path to WSL path
    const wslPath = scriptPath
        .replace(/\\/g, '/')
        .replace(/^([A-Z]):/, (_, letter) => `/mnt/${letter.toLowerCase()}`);
    
    // 2>&1 redirects stderr(2) to stdout(1), then pipe through cat to prevent pagers
    const command = `wsl bash "${wslPath}" 2>&1 | cat`;
    return executeInTerminal(command, 'Script Runner (WSL)', isBackground, timeoutMs);
}

/**
 * Execute a Bash script file via Git Bash in VS Code terminal.
 * 
 * Since we're executing from a PowerShell terminal, we use & to invoke Git Bash.
 * The script is wrapped with bash -c to handle stderr redirection and cat piping
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
    // Convert backslashes to forward slashes for Git Bash
    const bashPath = scriptPath.replace(/\\/g, '/');
    
    // Use bash -c to run the script with proper stderr redirection inside bash
    // The entire command runs in bash context where 2>&1 | cat works correctly
    const command = `& "C:\\Program Files\\Git\\bin\\bash.exe" -c 'bash "${bashPath}" 2>&1 | cat'`;
    return executeInTerminal(command, 'Script Runner (Git Bash)', isBackground, timeoutMs);
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
        output.push(`Use get_terminal_output to check output later.`);
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
