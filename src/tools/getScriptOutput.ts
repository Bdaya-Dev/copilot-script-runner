import * as vscode from 'vscode';
import { getTerminalById, getCommand, getLastCommandForTerminal, cleanOutput } from '../utils/scriptExecutor';

interface IGetScriptOutputParameters {
    /** The command ID returned by runScript. Provide this OR terminalId. */
    commandId?: string;
    /** A terminal ID — returns output of the most recent command on that terminal. Provide this OR commandId. */
    terminalId?: string;
    waitForCompletion?: boolean;
    timeoutMs?: number;
}

export class GetScriptOutputTool implements vscode.LanguageModelTool<IGetScriptOutputParameters> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IGetScriptOutputParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { commandId, terminalId, waitForCompletion = false, timeoutMs } = options.input;

        if (!commandId && !terminalId) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Either commandId or terminalId must be provided.')
            ]);
        }

        // Resolve the command — either directly by commandId, or by finding the
        // most recent command on the given terminal.
        const command = commandId
            ? getCommand(commandId)
            : getLastCommandForTerminal(terminalId!);

        if (!command) {
            const identifier = commandId ? `command ID "${commandId}"` : `terminal ID "${terminalId}"`;
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`No command found for ${identifier}. It may have expired, the ID is invalid, or no commands have been run on this terminal yet.`)
            ]);
        }

        const terminal = getTerminalById(command.terminalId);
        if (!terminal) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Terminal for command "${command.commandId}" not found. It may have been closed.`)
            ]);
        }

        let timedOut = false;
        if (waitForCompletion && !command.completed) {
            if (timeoutMs !== undefined) {
                const timeoutPromise = new Promise<'timeout'>((resolve) =>
                    setTimeout(() => resolve('timeout'), timeoutMs)
                );
                const result = await Promise.race([command.completionPromise.then(() => 'done' as const), timeoutPromise]);
                timedOut = result === 'timeout';
            } else {
                await command.completionPromise;
            }
        }

        const result = [
            `Terminal: ${terminal.name}`,
            `Terminal ID: ${command.terminalId}`,
            `Command ID: ${commandId}`,
            `Status: ${command.completed ? 'completed' : timedOut ? 'timed out (still running)' : 'running'}`,
            command.exitCode !== undefined ? `Exit Code: ${command.exitCode}` : undefined,
            '',
            'Output:',
            cleanOutput(command.output, command.commandText) || '(no output)',
        ].filter(line => line !== undefined).join('\n');

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(result)
        ]);
    }
}
