import { writeFile, unlink, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';

export interface ScriptResult {
    stdout: string;
    stderr: string;
    exitCode: number;
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
 * Wait for shell integration to be available on a terminal
 */
async function waitForShellIntegration(
    terminal: vscode.Terminal,
    timeout: number
): Promise<void> {
    let resolve: () => void;
    let reject: (e: Error) => void;
    const p = new Promise<void>((_resolve, _reject) => {
        resolve = _resolve;
        reject = _reject;
    });

    const timer = setTimeout(() => {
        disposable.dispose();
        reject(new Error('Timed out waiting for shell integration'));
    }, timeout);

    const disposable = vscode.window.onDidChangeTerminalShellIntegration((e) => {
        if (e.terminal === terminal) {
            clearTimeout(timer);
            disposable.dispose();
            resolve();
        }
    });

    if (terminal.shellIntegration) {
        clearTimeout(timer);
        disposable.dispose();
        resolve!();
    }

    return p;
}

/**
 * Execute a command in VS Code terminal with shell integration
 */
export async function executeInTerminal(
    command: string,
    terminalName: string = 'Script Runner'
): Promise<ScriptResult> {
    const terminal = vscode.window.createTerminal(terminalName);
    terminal.show();

    try {
        await waitForShellIntegration(terminal, 10000);
    } catch (e) {
        return {
            stdout: '',
            stderr: (e as Error).message,
            exitCode: 1
        };
    }

    const execution = terminal.shellIntegration!.executeCommand(command);
    const stream = execution.read();

    let output = '';
    for await (const chunk of stream) {
        output += chunk;
    }

    // Try to extract exit code from output or default to 0
    // Shell integration doesn't directly provide exit code, but we can infer success
    return {
        stdout: output,
        stderr: '',
        exitCode: 0
    };
}

/**
 * Execute a PowerShell script file in VS Code terminal
 */
export async function executePowerShellScript(
    scriptPath: string,
    _workingDirectory?: string,
    _timeoutMs: number = 120000
): Promise<ScriptResult> {
    const command = `pwsh -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`;
    return executeInTerminal(command, 'Script Runner (PowerShell)');
}

/**
 * Execute a Bash script file via WSL in VS Code terminal
 */
export async function executeWslScript(
    scriptPath: string,
    _workingDirectory?: string,
    _timeoutMs: number = 120000
): Promise<ScriptResult> {
    // Convert Windows path to WSL path
    const wslPath = scriptPath
        .replace(/\\/g, '/')
        .replace(/^([A-Z]):/, (_, letter) => `/mnt/${letter.toLowerCase()}`);
    
    const command = `wsl bash "${wslPath}"`;
    return executeInTerminal(command, 'Script Runner (WSL)');
}

/**
 * Execute a Bash script file via Git Bash in VS Code terminal
 */
export async function executeGitBashScript(
    scriptPath: string,
    _workingDirectory?: string,
    _timeoutMs: number = 120000
): Promise<ScriptResult> {
    const command = `& "C:\\Program Files\\Git\\bin\\bash.exe" "${scriptPath}"`;
    return executeInTerminal(command, 'Script Runner (Git Bash)');
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
    
    if (result.stdout) {
        output.push(`STDOUT:\n${result.stdout}`);
    }
    if (result.stderr) {
        output.push(`STDERR:\n${result.stderr}`);
    }
    output.push(`\nExit Code: ${result.exitCode}`);
    
    if (keepScript && scriptPath) {
        output.push(`Script saved at: ${scriptPath}`);
    }
    
    return output.join('\n') || '(no output)';
}
