import * as vscode from 'vscode';
import { getTerminalById, getCommand } from '../utils/scriptExecutor';

interface IGetScriptOutputParameters {
    commandId: string;
    waitForCompletion?: boolean;
}

export class GetScriptOutputTool implements vscode.LanguageModelTool<IGetScriptOutputParameters> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IGetScriptOutputParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { commandId, waitForCompletion = false } = options.input;

        const command = getCommand(commandId);
        if (!command) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Command with ID "${commandId}" not found. It may have expired or the ID is invalid.`)
            ]);
        }

        const terminal = getTerminalById(command.terminalId);
        if (!terminal) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Terminal for command "${commandId}" not found. It may have been closed.`)
            ]);
        }

        if (waitForCompletion && !command.completed) {
            await command.completionPromise;
        }

        const result = [
            `Terminal: ${terminal.name}`,
            `Command ID: ${commandId}`,
            `Status: ${command.completed ? 'completed' : 'running'}`,
            '',
            'Output:',
            command.output || '(no output)',
        ].join('\n');

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(result)
        ]);
    }
}
