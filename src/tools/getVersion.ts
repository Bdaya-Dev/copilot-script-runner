import * as vscode from 'vscode';
import { VERSION, DISPLAY_NAME, EXTENSION_ID } from '../version';

export class GetVersionTool implements vscode.LanguageModelTool<Record<string, never>> {
    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const output = [
            `Extension: ${DISPLAY_NAME}`,
            `ID: ${EXTENSION_ID}`,
            `Version: ${VERSION}`,
        ].join('\n');

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(output)
        ]);
    }
}
