import * as vscode from 'vscode';
import {
    getTempDir,
    generateScriptPath,
    executeScript,
    writeScriptFile,
    cleanupScriptFile,
    formatOutput,
    getScriptExtension,
    ShellType
} from '../utils/scriptExecutor';

/**
 * Shell types supported by this tool.
 * Maps user-friendly names to internal ShellType enum.
 */
type ShellInput = 'powershell' | 'bash' | 'wsl' | 'gitbash' | 'zsh' | 'fish';

const shellInputToType: Record<ShellInput, ShellType> = {
    'powershell': ShellType.PowerShell,
    'bash': ShellType.Bash,
    'wsl': ShellType.Wsl,
    'gitbash': ShellType.GitBash,
    'zsh': ShellType.Zsh,
    'fish': ShellType.Fish
};

const shellDisplayNames: Record<ShellInput, string> = {
    'powershell': 'PowerShell',
    'bash': 'Bash',
    'wsl': 'WSL (Bash)',
    'gitbash': 'Git Bash',
    'zsh': 'Zsh',
    'fish': 'Fish'
};

const shellSyntaxHighlight: Record<ShellInput, string> = {
    'powershell': 'powershell',
    'bash': 'bash',
    'wsl': 'bash',
    'gitbash': 'bash',
    'zsh': 'bash',
    'fish': 'fish'
};

interface IRunScriptParameters {
    script: string;
    shell?: ShellInput;
    workingDirectory?: string;
    timeoutMs?: number;
    keepScript?: boolean;
    isBackground?: boolean;
    closeOnTimeout?: boolean;
}

export class RunScriptTool implements vscode.LanguageModelTool<IRunScriptParameters> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IRunScriptParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { 
            script, 
            shell = 'powershell',
            workingDirectory, 
            timeoutMs,
            keepScript = false,
            isBackground = false,
            closeOnTimeout = false
        } = options.input;

        const shellType = shellInputToType[shell] ?? ShellType.PowerShell;
        const extension = getScriptExtension(shellType);
        const tempDir = await getTempDir();
        const scriptPath = generateScriptPath(tempDir, extension);

        try {
            // For bash-like scripts, ensure proper line endings and add shebang if missing
            let processedScript = script;
            if (shell !== 'powershell') {
                processedScript = script.replace(/\r\n/g, '\n');
                if (!processedScript.startsWith('#!')) {
                    const shebang = shell === 'fish' ? '#!/usr/bin/env fish' : '#!/bin/bash\nset -e';
                    processedScript = `${shebang}\n${processedScript}`;
                }
            }

            await writeScriptFile(scriptPath, processedScript);
            const result = await executeScript(scriptPath, shellType, timeoutMs, isBackground, closeOnTimeout);

            // For background processes, don't clean up immediately
            if (!keepScript && !isBackground) {
                await cleanupScriptFile(scriptPath);
            }

            const output = formatOutput(result, keepScript || isBackground, scriptPath);

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(output)
            ]);
        } catch (error) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error: ${(error as Error).message}`)
            ]);
        }
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IRunScriptParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const script = options.input.script;
        const shell = options.input.shell ?? 'powershell';
        const displayName = shellDisplayNames[shell] ?? 'PowerShell';
        const syntaxHighlight = shellSyntaxHighlight[shell] ?? 'bash';
        const bgNote = options.input.isBackground ? '\n\n*Running in background mode*' : '';

        return {
            invocationMessage: options.input.isBackground 
                ? `Starting background ${displayName} script...` 
                : `Running ${displayName} script...`,
            confirmationMessages: {
                title: `Run ${displayName} Script`,
                message: new vscode.MarkdownString(
                    `Run this ${displayName} script?\n\n\`\`\`${syntaxHighlight}\n${script}\n\`\`\`${bgNote}`
                ),
            },
        };
    }
}
