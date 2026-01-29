import * as vscode from 'vscode';
import {
    getTempDir,
    generateScriptPath,
    executeWslScript,
    executeGitBashScript,
    writeScriptFile,
    cleanupScriptFile,
    formatOutput
} from '../utils/scriptExecutor';

interface IRunBashScriptParameters {
    script: string;
    workingDirectory?: string;
    shell?: 'wsl' | 'gitbash';
    timeoutMs?: number;
    keepScript?: boolean;
}

export class RunBashScriptTool implements vscode.LanguageModelTool<IRunBashScriptParameters> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IRunBashScriptParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { 
            script, 
            workingDirectory, 
            shell = 'wsl', 
            timeoutMs = 120000, 
            keepScript = false 
        } = options.input;

        const tempDir = await getTempDir();
        const scriptPath = generateScriptPath(tempDir, '.sh');

        try {
            // Ensure LF line endings and add shebang if missing
            let bashScript = script.replace(/\r\n/g, '\n');
            if (!bashScript.startsWith('#!')) {
                bashScript = '#!/bin/bash\nset -e\n' + bashScript;
            }

            await writeScriptFile(scriptPath, bashScript);

            const result = shell === 'wsl'
                ? await executeWslScript(scriptPath, workingDirectory, timeoutMs)
                : await executeGitBashScript(scriptPath, workingDirectory, timeoutMs);

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
        options: vscode.LanguageModelToolInvocationPrepareOptions<IRunBashScriptParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        // Get first few lines for display
        const scriptPreview = options.input.script.split('\n').slice(0, 3).join('\n');
        const hasMore = options.input.script.split('\n').length > 3;
        const shell = options.input.shell || 'wsl';

        return {
            invocationMessage: `Running Bash script via ${shell.toUpperCase()}...`,
            confirmationMessages: {
                title: 'Run Bash Script',
                message: new vscode.MarkdownString(
                    `Run this Bash script via ${shell.toUpperCase()}?\n\n\`\`\`bash\n${scriptPreview}${hasMore ? '\n...' : ''}\n\`\`\`\n`
                ),
            },
        };
    }
}
