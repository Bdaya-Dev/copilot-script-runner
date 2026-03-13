import * as vscode from 'vscode';
import {
    closeTerminalById,
    interruptTerminal,
    sendTextToTerminal,
    getTerminalById
} from '../utils/scriptExecutor';

type TerminalAction = 'close' | 'interrupt' | 'send_input';

interface IManageTerminalParameters {
    terminalId: string;
    action: TerminalAction;
    input?: string;
}

export class ManageTerminalTool implements vscode.LanguageModelTool<IManageTerminalParameters> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IManageTerminalParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { terminalId, action, input } = options.input;

        const terminal = getTerminalById(terminalId);
        if (!terminal) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `Terminal with ID "${terminalId}" not found. Use script-runner_list_terminals to see available terminals.`
                )
            ]);
        }

        switch (action) {
            case 'close': {
                const closed = closeTerminalById(terminalId);
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        closed ? `Terminal "${terminalId}" closed.` : `Failed to close terminal "${terminalId}".`
                    )
                ]);
            }

            case 'interrupt': {
                const sent = interruptTerminal(terminalId);
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        sent ? `Sent Ctrl+C (SIGINT) to terminal "${terminalId}".` : `Failed to send interrupt to terminal "${terminalId}".`
                    )
                ]);
            }

            case 'send_input': {
                if (!input) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart('The "input" parameter is required for send_input action.')
                    ]);
                }
                const sent = sendTextToTerminal(terminalId, input, true);
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        sent ? `Sent input to terminal "${terminalId}".` : `Failed to send input to terminal "${terminalId}".`
                    )
                ]);
            }

            default:
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Unknown action "${action}". Valid actions: close, interrupt, send_input.`)
                ]);
        }
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IManageTerminalParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const { terminalId, action } = options.input;

        const actionMessages: Record<TerminalAction, string> = {
            'close': `Close terminal ${terminalId}`,
            'interrupt': `Send Ctrl+C to terminal ${terminalId}`,
            'send_input': `Send input to terminal ${terminalId}`
        };

        return {
            invocationMessage: actionMessages[action] ?? `Manage terminal ${terminalId}`,
            confirmationMessages: {
                title: 'Manage Terminal',
                message: new vscode.MarkdownString(
                    `**Action:** ${action}\n**Terminal ID:** ${terminalId}${options.input.input ? `\n**Input:** \`${options.input.input}\`` : ''}`
                ),
            },
        };
    }
}
