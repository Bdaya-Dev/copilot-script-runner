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
}

export class RunScriptTool implements vscode.LanguageModelTool<IRunScriptParameters> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IRunScriptParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { script, workingDirectory, timeoutMs = 120000, keepScript = false } = options.input;

        const tempDir = await getTempDir();
        const scriptPath = generateScriptPath(tempDir, '.ps1');

        try {
            await writeScriptFile(scriptPath, script);
            const result = await executePowerShellScript(scriptPath, workingDirectory, timeoutMs);

            if (!keepScript) {
                await cleanupScriptFile(scriptPath);
            }

            const output = formatOutput(result, keepScript, scriptPath);

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
        // Get first few lines for display
        const scriptPreview = options.input.script.split('\n').slice(0, 3).join('\n');
        const hasMore = options.input.script.split('\n').length > 3;

        return {
            invocationMessage: 'Running PowerShell script...',
            confirmationMessages: {
                title: 'Run PowerShell Script',
                message: new vscode.MarkdownString(
                    `Run this PowerShell script?\n\n\`\`\`powershell\n${scriptPreview}${hasMore ? '\n...' : ''}\n\`\`\`\n`
                ),
            },
        };
    }
}
