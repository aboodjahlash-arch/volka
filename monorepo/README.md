# VOLK AI

An AI agent platform for cybersecurity and ethical hacking combining VS Code integration, Gemini 2.5 Flash LLM, and autonomous multi-step task execution.

## Architecture

```
monorepo/
├── ext/          # VS Code Extension (editor integration)
│   └── src/
│       └── extension.ts    # Main extension entry point
├── agent-core/   # Agent runtime (planner-executor loop)
│   └── src/
│       └── index.ts        # AgentCore class, LLM integration, tool system
├── shared/       # Common types and utilities
│   └── src/
│       └── index.ts        # TypeScript interfaces for all layers
├── sandbox/      # Docker sandbox management
│   └── src/
│       └── index.ts        # SandboxManager with Dockerode
├── .vscode/      # VS Code workspace settings
├── tsconfig.json # Root TypeScript configuration (strict mode)
├── .eslintrc.json # ESLint configuration
└── .prettierrc   # Prettier configuration
```

## Key Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@google/genai` | ^1.12.0 | Gemini 2.5 Flash LLM integration |
| `better-sqlite3` | ^11.9.1 | Workspace index and conversation storage |
| `tree-sitter` | ^0.22.4 | AST-level code analysis |
| `dockerode` | ^4.0.5 | Docker sandbox management |

## Getting Started

```bash
# Install dependencies
npm install

# Build all workspaces
npm run build

# Type check
npm run typecheck

# Lint
npm run lint

# Format
npm run format
```

## Development

Set the `GEMINI_API_KEY` environment variable with your Gemini API key before running the extension.

```bash
export GEMINI_API_KEY="your-api-key-here"
```

In VS Code, press F5 to launch the extension development host.

## VS Code Extension

The extension provides:
- Inline ghost-text completions
- Codebase-aware chat sidebar
- Slash commands: `/fix`, `/test`, `/refactor`, `/explain`, `/commit`
- Multi-file diff previews with apply/revert controls
- Autonomous task execution with permission model
- Auditable execution traces

## License

MIT
