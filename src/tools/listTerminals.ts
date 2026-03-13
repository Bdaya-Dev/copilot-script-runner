import * as vscode from 'vscode';
import { getAllTerminals, getCommandsForTerminal } from '../utils/scriptExecutor';

export class ListTerminalsTool implements vscode.LanguageModelTool<Record<string, never>> {
    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const terminals = getAllTerminals();

        if (terminals.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('No active Script Runner terminals.')
            ]);
        }

        const lines: string[] = [`Active terminals: ${terminals.length}`, ''];

        for (const t of terminals) {
            lines.push(`--- Terminal: ${t.name} ---`);
            lines.push(`  Terminal ID: ${t.terminalId}`);
            lines.push(`  Status: ${t.isBusy ? 'busy' : 'idle'}`);
            if (t.cwd) {
                lines.push(`  Working Directory: ${t.cwd}`);
            }

            const commands = getCommandsForTerminal(t.terminalId);
            if (commands.length > 0) {
                lines.push(`  Commands (${commands.length}):`);
                for (const cmd of commands) {
                    const elapsed = Math.round((Date.now() - cmd.startedAt) / 1000);
                    lines.push(`    - ${cmd.commandId}: ${cmd.completed ? 'completed' : 'running'} (${elapsed}s)`);
                }
            } else {
                lines.push('  Commands: none');
            }
            lines.push('');
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(lines.join('\n'))
        ]);
    }
}
