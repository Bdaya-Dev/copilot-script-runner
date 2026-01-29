# Script Runner for VS Code

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/bdayadev.vscode-script-runner?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=bdayadev.vscode-script-runner)
[![Open VSX](https://img.shields.io/open-vsx/v/bdayadev/vscode-script-runner?label=Open%20VSX)](https://open-vsx.org/extension/bdayadev/vscode-script-runner)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

AI-powered Language Model tools for running multi-line PowerShell and Bash scripts in VS Code. This extension solves the common issue where AI agents fail when using `run_in_terminal` with multi-line commands.

## Features

- **`#runScript`** - Run PowerShell scripts (recommended for Windows)
- **`#runBashScript`** - Run Bash scripts via WSL or Git Bash

### How It Works

1. The AI agent calls the tool with a multi-line script
2. The extension writes the script to a temporary file
3. A VS Code terminal opens and executes the script
4. Output is captured and returned to the AI agent
5. The temp file is automatically cleaned up

### Why Use This?

The built-in `run_in_terminal` tool can fail with multi-line commands due to:
- Command parsing/escaping issues
- Terminal emulator quirks
- Inconsistent output capture

Script Runner solves these by writing scripts to files first, ensuring reliable execution of complex, multi-line scripts.

## Usage

In GitHub Copilot Chat, reference the tools:

```
@workspace Use #runScript to install dependencies and run the build
```

```
@workspace Use #runBashScript to run the deployment script
```

## Tool Parameters

### #runScript (PowerShell)

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `script` | string | ✅ | - | PowerShell script content |
| `workingDirectory` | string | ❌ | cwd | Working directory |
| `timeoutMs` | number | ❌ | 120000 | Timeout in ms |
| `keepScript` | boolean | ❌ | false | Keep temp file for debugging |

### #runBashScript (Bash)

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `script` | string | ✅ | - | Bash script content |
| `workingDirectory` | string | ❌ | cwd | Working directory |
| `shell` | "wsl" \| "gitbash" | ❌ | "wsl" | Shell to use |
| `timeoutMs` | number | ❌ | 120000 | Timeout in ms |
| `keepScript` | boolean | ❌ | false | Keep temp file for debugging |

## Requirements

- VS Code 1.100.0 or higher
- GitHub Copilot extension
- For Bash: WSL or Git Bash installed

## Installation

### From VS Code Marketplace

1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X)
3. Search for "Script Runner"
4. Click Install

### From Open VSX

1. Open VS Code or VSCodium
2. Go to Extensions
3. Search for "Script Runner" by bdaya-dev
4. Click Install

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## About

Made with ❤️ by [Bdaya Dev](https://github.com/bdaya-dev)
