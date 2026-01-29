# Publishing Guide

This project uses [semantic-release](https://semantic-release.gitbook.io/) for automated versioning and publishing.

## How It Works

1. Push commits to `main` branch using [Conventional Commits](https://www.conventionalcommits.org/)
2. semantic-release analyzes commits and determines version bump
3. Automatically publishes to VS Code Marketplace and Open VSX
4. Creates GitHub Release with VSIX asset

## Commit Message Format

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

### Types

| Type | Version Bump | Description |
|------|--------------|-------------|
| `feat` | Minor | New feature |
| `fix` | Patch | Bug fix |
| `perf` | Patch | Performance improvement |
| `docs` | None | Documentation only |
| `style` | None | Code style changes |
| `refactor` | None | Code refactoring |
| `test` | None | Adding tests |
| `chore` | None | Maintenance |

### Breaking Changes

Add `BREAKING CHANGE:` in footer or `!` after type for major version bump:

```
feat!: remove deprecated API

BREAKING CHANGE: The old API has been removed.
```

## Prerequisites

### 1. VS Code Marketplace Publisher

1. Go to https://marketplace.visualstudio.com/manage
2. Create publisher with ID `bdaya-dev`
3. Create Personal Access Token at https://dev.azure.com/bdaya-dev/_usersSettings/tokens
   - Organization: `All accessible organizations`
   - Scopes: Marketplace → Manage

### 2. Open VSX Namespace

1. Go to https://open-vsx.org/
2. Sign in with GitHub
3. Create namespace `bdaya-dev`
4. Generate token at https://open-vsx.org/user-settings/tokens

### 3. GitHub Secrets

Add these secrets at `Settings → Secrets → Actions`:

| Secret | Description |
|--------|-------------|
| `VSCE_PAT` | VS Code Marketplace token |
| `OVSX_PAT` | Open VSX token |

## Icon

Create a 128x128 PNG icon:

1. Convert `images/icon.svg` to PNG: https://cloudconvert.com/svg-to-png
2. Save as `images/icon.png`
3. Commit and push

## Manual Publishing (if needed)

```bash
# Install tools
npm install -g @vscode/vsce ovsx

# Package
npm run compile
npx vsce package

# Publish
npx vsce publish -p <VSCE_PAT>
npx ovsx publish -p <OVSX_PAT> *.vsix
```
