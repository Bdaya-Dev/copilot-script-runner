import * as vscode from 'vscode';
import { getTerminalById, getLastExecution } from '../utils/scriptExecutor';

interface IGetScriptOutputParameters {
    id: string;
}

export class GetScriptOutputTool implements vscode.LanguageModelTool<IGetScriptOutputParameters> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IGetScriptOutputParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { id } = options.input;

        const terminal = getTerminalById(id);
        const execution = getLastExecution(id);

        if (!terminal) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Terminal with ID "${id}" not found. It may have been closed or the ID is invalid.`)
            ]);
        }

        if (!execution) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`No command execution found for terminal "${id}". The command may not have been executed yet.`)
            ]);
        }

        // Read the output from the stored execution
        let output = '';
        try {
            const stream = execution.read();
            for await (const chunk of stream) {
                output += chunk;
            }
        } catch (error) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error reading output: ${(error as Error).message}`)
            ]);
        }

        const result = [
            `Terminal: ${terminal.name}`,
            `Terminal ID: ${id}`,
            '',
            'Output:',
            output || '(no output)',
        ].join('\n');

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(result)
        ]);
    }
}
