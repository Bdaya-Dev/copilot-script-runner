import * as vscode from 'vscode';
import { RunScriptTool } from './tools/runScript';
import { RunBashScriptTool } from './tools/runBashScript';

export function activate(context: vscode.ExtensionContext) {
    console.log('Script Runner extension is now active');

    // Register the PowerShell script tool
    context.subscriptions.push(
        vscode.lm.registerTool('script-runner_run_script', new RunScriptTool())
    );

    // Register the Bash script tool
    context.subscriptions.push(
        vscode.lm.registerTool('script-runner_run_bash_script', new RunBashScriptTool())
    );
}

export function deactivate() {
    console.log('Script Runner extension is now deactivated');
}
