import * as vscode from 'vscode';
import {
    getTempDir,
    generateScriptPath,
    executePowerShellScript,
    writeScriptFile,
    cleanupScriptFile,
    formatOutput
} from '../utils/scriptExecutor';

interface IRunScriptParameters {
    script: string;
    workingDirectory?: string;
    timeoutMs?: number;
    keepScript?: boolean;
    isBackground?: boolean;
}

export class RunScriptTool implements vscode.LanguageModelTool<IRunScriptParameters> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IRunScriptParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { 
            script, 
            workingDirectory, 
            timeoutMs,
            keepScript = false,
            isBackground = false 
        } = options.input;

        const tempDir = await getTempDir();
        const scriptPath = generateScriptPath(tempDir, '.ps1');

        try {
            await writeScriptFile(scriptPath, script);
            const result = await executePowerShellScript(scriptPath, workingDirectory, timeoutMs, isBackground);

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
        // Display entire script
        const scriptPreview = options.input.script;
        const bgNote = options.input.isBackground ? '\n\n*Running in background mode*' : '';

        return {
            invocationMessage: options.input.isBackground 
                ? 'Starting background PowerShell script...' 
                : 'Running PowerShell script...',
            confirmationMessages: {
                title: 'Run PowerShell Script',                
                message: new vscode.MarkdownString(
                    `Run this PowerShell script?\n\n\`\`\`powershell\n${scriptPreview}\n\`\`\`${bgNote}\n`
                ),
            },
        };
    }
}
