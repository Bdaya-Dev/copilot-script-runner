import * as vscode from 'vscode';
import { RunScriptTool } from './tools/runScript';
import { GetVersionTool } from './tools/getVersion';
import { GetScriptOutputTool } from './tools/getScriptOutput';

export function activate(context: vscode.ExtensionContext) {
    console.log('Script Runner extension is now active');

    // Register the unified script tool (supports powershell, bash, wsl, gitbash, zsh, fish)
    context.subscriptions.push(
        vscode.lm.registerTool('script-runner_run_script', new RunScriptTool())
    );

    // Register the version info tool
    context.subscriptions.push(
        vscode.lm.registerTool('script-runner_get_version', new GetVersionTool())
    );

    // Register the get script output tool
    context.subscriptions.push(
        vscode.lm.registerTool('script-runner_get_output', new GetScriptOutputTool())
    );
}

export function deactivate() {
    console.log('Script Runner extension is now deactivated');
}
