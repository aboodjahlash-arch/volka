/**
 * @ai-agent/ext - VS Code Extension: VOLK AI
 *
 * This is the main entry point for the VS Code extension.
 * It provides inline AI edits, codebase-aware chat, and autonomous agent capabilities.
 *
 * Uses the GeminiProvider from @ai-agent/agent-core/providers/gemini-provider
 * for LLM integration with streaming, function calling, and telemetry.
 */

import * as vscode from 'vscode';
import { AgentCore, LLMProviderFactory } from '@ai-agent/agent-core';
import type { LLMProvider, LLMMessage, AgentTool, DiffEdit } from '@ai-agent/shared';

// File System Tools for the Agent
function createFileSystemTools(): AgentTool[] {
  return [
    {
      name: 'read_file',
      description: 'Read the contents of a file in the workspace',
      category: 'filesystem',
      permissionLevel: 'safe',
      async execute(input: Record<string, unknown>): Promise<{ success: boolean; output: string; error?: string }> {
        const filePath = input.path as string;
        try {
          const document = await vscode.workspace.openTextDocument(filePath);
          return { success: true, output: document.getText() };
        } catch (error) {
          return { success: false, output: '', error: `Failed to read file: ${String(error)}` };
        }
      },
    },
    {
      name: 'write_file',
      description: 'Write content to a file in the workspace',
      category: 'filesystem',
      permissionLevel: 'safe',
      async execute(input: Record<string, unknown>): Promise<{ success: boolean; output: string; error?: string }> {
        const filePath = input.path as string;
        const content = input.content as string;
        try {
          const workspaceFolders = vscode.workspace.workspaceFolders;
          if (!workspaceFolders) {
            return { success: false, output: '', error: 'No workspace folder open' };
          }
          const fullPath = workspaceFolders[0].uri.with({ path: filePath });
          await vscode.workspace.fs.writeFile(
            fullPath,
            Buffer.from(content, 'utf-8'),
          );
          return { success: true, output: `Written ${content.length} bytes to ${filePath}` };
        } catch (error) {
          return { success: false, output: '', error: `Failed to write file: ${String(error)}` };
        }
      },
    },
    {
      name: 'list_files',
      description: 'List files in a directory of the workspace',
      category: 'filesystem',
      permissionLevel: 'safe',
      async execute(input: Record<string, unknown>): Promise<{ success: boolean; output: string; error?: string }> {
        const dirPath = input.path as string;
        try {
          const workspaceFolders = vscode.workspace.workspaceFolders;
          if (!workspaceFolders) {
            return { success: false, output: '', error: 'No workspace folder open' };
          }
          const uri = workspaceFolders[0].uri.with({ path: dirPath });
          const files = await vscode.workspace.fs.readDirectory(uri);
          const listing = files
            .map(([name, type]) => `${type === vscode.FileType.Directory ? '[DIR]' : '[FILE]'} ${name}`)
            .join('\n');
          return { success: true, output: listing };
        } catch (error) {
          return { success: false, output: '', error: `Failed to list directory: ${String(error)}` };
        }
      },
    },
    {
      name: 'create_file',
      description: 'Create a new file in the workspace',
      category: 'filesystem',
      permissionLevel: 'safe',
      async execute(input: Record<string, unknown>): Promise<{ success: boolean; output: string; error?: string }> {
        const filePath = input.path as string;
        const content = (input.content as string) ?? '';
        try {
          const workspaceFolders = vscode.workspace.workspaceFolders;
          if (!workspaceFolders) {
            return { success: false, output: '', error: 'No workspace folder open' };
          }
          const fullPath = workspaceFolders[0].uri.with({ path: filePath });
          await vscode.workspace.fs.writeFile(fullPath, Buffer.from(content, 'utf-8'));
          return { success: true, output: `Created file ${filePath}` };
        } catch (error) {
          return { success: false, output: '', error: `Failed to create file: ${String(error)}` };
        }
      },
    },
    {
      name: 'delete_file',
      description: 'Delete a file from the workspace (requires confirmation)',
      category: 'filesystem',
      permissionLevel: 'confirm_required',
      async execute(input: Record<string, unknown>): Promise<{ success: boolean; output: string; error?: string }> {
        const filePath = input.path as string;
        try {
          const workspaceFolders = vscode.workspace.workspaceFolders;
          if (!workspaceFolders) {
            return { success: false, output: '', error: 'No workspace folder open' };
          }
          const fullPath = workspaceFolders[0].uri.with({ path: filePath });
          await vscode.workspace.fs.delete(fullPath);
          return { success: true, output: `Deleted file ${filePath}` };
        } catch (error) {
          return { success: false, output: '', error: `Failed to delete file: ${String(error)}` };
        }
      },
    },
  ];
}

// The VOLK AI ViewProvider for the sidebar chat
class VolkAiViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'volkAi.chat';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _llmProvider: LLMProvider,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlContent();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'chat:message': {
          await this._handleChatMessage(message.text);
          break;
        }
        case 'chat:clear': {
          break;
        }
        case 'command:run': {
          await this._handleSlashCommand(message.command, message.args);
          break;
        }
      }
    });
  }

  private async _handleChatMessage(text: string): Promise<void> {
    if (!this._view) return;

    this._view.webview.postMessage({
      type: 'chat:streaming',
      content: '',
    });

    try {
      const editor = vscode.window.activeTextEditor;
      const contextPrompt = editor
        ? `Current file: ${editor.document.fileName}\nSelection: ${editor.document.getText(editor.selection)}`
        : 'No active editor';

      const messages: LLMMessage[] = [
        {
          role: 'system',
          content: `You are VOLK AI, an AI coding agent specialized in cybersecurity and ethical hacking, integrated into VS Code. Help the user with their code and security tasks.
Context: ${contextPrompt}

Available commands:
- /fix - Fix issues in the current file
- /test - Generate tests for the current selection
- /refactor - Refactor the selected code
- /explain - Explain the selected code
- /commit - Generate a commit message

You can propose edits using the format:
\`\`\`edit
file: path/to/file.ts
<<<<<<< original
original code
=======
modified code
>>>>>>>
\`\`\``,
        },
        { role: 'user', content: text },
      ];

      let fullResponse = '';
      for await (const chunk of this._llmProvider.stream({ messages })) {
        fullResponse += chunk.content;
        this._view.webview.postMessage({
          type: 'chat:streaming',
          content: fullResponse,
        });
      }

      this._view.webview.postMessage({
        type: 'chat:complete',
        content: fullResponse,
      });

      await this._applyEditsFromResponse(fullResponse);
    } catch (error) {
      this._view.webview.postMessage({
        type: 'chat:error',
        error: String(error),
      });
    }
  }

  private async _handleSlashCommand(command: string, _args: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active editor');
      return;
    }

    const selection = editor.selection;
    const selectedText = editor.document.getText(selection);
    const fileContent = editor.document.getText();

    let prompt = '';
    switch (command) {
      case 'fix':
        prompt = `Fix any issues in this code:\n\`\`\`\n${fileContent}\n\`\`\``;
        break;
      case 'test':
        prompt = `Generate tests for this code:\n\`\`\`\n${selectedText || fileContent}\n\`\`\``;
        break;
      case 'refactor':
        prompt = `Refactor this code to improve it:\n\`\`\`\n${selectedText || fileContent}\n\`\`\``;
        break;
      case 'explain':
        prompt = `Explain this code in detail:\n\`\`\`\n${selectedText || fileContent}\n\`\`\``;
        break;
      case 'commit':
        prompt = `Generate a concise git commit message for these changes:\n\`\`\`\n${fileContent}\n\`\`\``;
        break;
    }

    if (this._view) {
      this._view.webview.postMessage({
        type: 'chat:streaming',
        content: '',
      });
    }

    const messages: LLMMessage[] = [
      { role: 'system', content: 'You are VOLK AI, an AI coding agent specialized in cybersecurity and ethical hacking. Respond concisely and precisely.' },
      { role: 'user', content: prompt },
    ];

    let fullResponse = '';
    for await (const chunk of this._llmProvider.stream({ messages })) {
      fullResponse += chunk.content;
      if (this._view) {
        this._view.webview.postMessage({
          type: 'chat:streaming',
          content: fullResponse,
        });
      }
    }

    if (this._view) {
      this._view.webview.postMessage({
        type: 'chat:complete',
        content: fullResponse,
      });
    }
  }

  private async _applyEditsFromResponse(response: string): Promise<void> {
    const editRegex = /```edit\nfile:\s*(.+?)\n<<<<<<< original\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>>\n```/g;
    const edits: DiffEdit[] = [];

    let match;
    while ((match = editRegex.exec(response)) !== null) {
      edits.push({
        filePath: match[1].trim(),
        original: match[2],
        modified: match[3],
        diff: '',
        accepted: false,
      });
    }

    if (edits.length === 0) return;

    const apply = await vscode.window.showInformationMessage(
      `Apply ${edits.length} proposed edit(s)?`,
      'Apply All',
      'Apply',
      'Cancel',
    );

    if (apply === 'Cancel' || !apply) return;

    for (const edit of edits) {
      try {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) continue;

        const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, edit.filePath);
        const document = await vscode.workspace.openTextDocument(fileUri);
        const fullContent = document.getText();

        if (fullContent.includes(edit.original)) {
          const editObj = new vscode.WorkspaceEdit();
          const startIdx = fullContent.indexOf(edit.original);
          const startPos = document.positionAt(startIdx);
          const endPos = document.positionAt(startIdx + edit.original.length);
          editObj.replace(fileUri, new vscode.Range(startPos, endPos), edit.modified);
          await vscode.workspace.applyEdit(editObj);
          edit.accepted = true;
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to apply edit to ${edit.filePath}: ${error}`);
      }
    }

    vscode.window.showInformationMessage(
      `Applied ${edits.filter((e) => e.accepted).length}/${edits.length} edits`,
    );
  }

  private _getHtmlContent(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VOLK AI</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-sideBar-background);
      padding: 8px;
      margin: 0;
    }
    #chat-container {
      display: flex;
      flex-direction: column;
      height: calc(100vh - 16px);
    }
    #messages {
      flex: 1;
      overflow-y: auto;
      margin-bottom: 8px;
    }
    .message {
      padding: 8px;
      margin-bottom: 8px;
      border-radius: 4px;
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    .message.user {
      background: var(--vscode-textBlockQuote-background);
      border-left: 3px solid var(--vscode-textLink-foreground);
    }
    .message.assistant {
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-left: 3px solid var(--vscode-editorInfo-foreground);
    }
    .message.system {
      background: transparent;
      font-style: italic;
      font-size: smaller;
    }
    #input-container {
      display: flex;
      gap: 4px;
    }
    #input-box {
      flex: 1;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      padding: 6px 8px;
      border-radius: 2px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    #input-box:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }
    #send-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 6px 12px;
      border-radius: 2px;
      cursor: pointer;
    }
    #send-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .edit-block {
      background: var(--vscode-diffEditor-insertedTextBackground);
      padding: 4px;
      margin: 4px 0;
      border-radius: 2px;
      font-family: monospace;
      font-size: smaller;
    }
  </style>
</head>
<body>
  <div id="chat-container">
    <div id="messages"></div>
    <div id="input-container">
      <input type="text" id="input-box" placeholder="Ask VOLK AI or type / for commands..." />
      <button id="send-btn">Send</button>
    </div>
  </div>
  <script>
    (function() {
      const vscode = acquireVsCodeApi();
      const messagesContainer = document.getElementById('messages');
      const inputBox = document.getElementById('input-box');
      const sendBtn = document.getElementById('send-btn');

      function addMessage(role, content) {
        const div = document.createElement('div');
        div.className = 'message ' + role;
        div.textContent = content;
        messagesContainer.appendChild(div);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
      }

      function updateLastMessage(content) {
        const last = messagesContainer.lastElementChild;
        if (last && last.className.includes('assistant')) {
          last.textContent = content;
          messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
      }

      window.addEventListener('message', event => {
        const message = event.data;
        switch (message.type) {
          case 'chat:streaming':
            if (!messagesContainer.querySelector('.message.assistant:last-child')) {
              addMessage('assistant', '');
            }
            updateLastMessage(message.content);
            break;
          case 'chat:complete':
            updateLastMessage(message.content);
            break;
          case 'chat:error':
            addMessage('system', 'Error: ' + message.error);
            break;
        }
      });

      function sendMessage() {
        const text = inputBox.value.trim();
        if (!text) return;

        addMessage('user', text);
        inputBox.value = '';

        if (text.startsWith('/')) {
          const parts = text.split(' ');
          const command = parts[0].slice(1);
          const args = parts.slice(1).join(' ');
          vscode.postMessage({ type: 'command:run', command, args });
        } else {
          vscode.postMessage({ type: 'chat:message', text });
        }
      }

      sendBtn.addEventListener('click', sendMessage);
      inputBox.addEventListener('keydown', e => {
        if (e.key === 'Enter') sendMessage();
      });

      addMessage('system', 'VOLK AI ready. Ask me anything about your code, or use /fix, /test, /refactor, /explain, /commit');
    })();
  </script>
</body>
</html>`;
  }
}

// Inline Completion Provider for ghost-text suggestions
class AIInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private _llmProvider: LLMProvider;

  constructor(llmProvider: LLMProvider) {
    this._llmProvider = llmProvider;
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    _token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionList | undefined> {
    const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
    const fileContent = document.getText();
    const cursorContext = fileContent + '<CURSOR>';

    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: `You are VOLK AI, an inline code completion engine specialized in cybersecurity. Given the code context, suggest the most likely completion.
Return ONLY the completion text, no explanations. Keep completions under 50 characters typically.
File: ${document.fileName}
Language: ${document.languageId}`,
      },
      {
        role: 'user',
        content: `Complete the code at cursor:\n\`\`\`\n${cursorContext}\n\`\`\`\nPrefix: "${linePrefix}"`,
      },
    ];

    try {
      const response = await this._llmProvider.generate({
        messages,
        maxTokens: 64,
        temperature: 0.1,
      });

      const trimmed = response.content.trim();
      if (!trimmed) return undefined;

      const item = new vscode.InlineCompletionItem(trimmed);
      return new vscode.InlineCompletionList([item]);
    } catch {
      return undefined;
    }
  }
}

// Extension activation
export function activate(context: vscode.ExtensionContext): void {
  console.warn('VOLK AI extension is now active');

  // Read API key from VS Code settings or environment
  const config = vscode.workspace.getConfiguration('volkAi');
  const apiKeyFromSettings: string | undefined = config.get('geminiApiKey');
  const apiKey = apiKeyFromSettings || process.env['GEMINI_API_KEY'] || '';

  if (!apiKey) {
    vscode.window.showErrorMessage(
      'VOLK AI: GEMINI_API_KEY is not set. Set it in VS Code settings (volkAi.geminiApiKey) or the GEMINI_API_KEY environment variable.',
    );
    return;
  }

  // Initialize LLM provider using the factory
  let llmProvider: LLMProvider;
  try {
    const factory = new LLMProviderFactory();
    llmProvider = factory.createProvider({
      type: 'gemini',
      apiKey,
      model: 'gemini-2.5-flash',
    });
  } catch (error) {
    vscode.window.showErrorMessage(
      `VOLK AI: Failed to initialize LLM provider - ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  // Initialize Agent Core
  const dbPath = context.globalStorageUri.fsPath + '/agent.db';
  const agentCore = new AgentCore(llmProvider, dbPath);

  // Register file system tools
  const fsTools = createFileSystemTools();
  for (const tool of fsTools) {
    agentCore.registerTool(tool);
  }

  // Register the sidebar chat view
  const provider = new VolkAiViewProvider(context.extensionUri, llmProvider);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VolkAiViewProvider.viewType, provider),
  );
  // Register inline completion provider
  const completionProvider = new AIInlineCompletionProvider(llmProvider);
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, completionProvider),
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('volkAi.openChat', () => {
      vscode.commands.executeCommand('workbench.view.extension.volkAi-chat');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('volkAi.explainCode', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        vscode.commands.executeCommand('workbench.view.extension.volkAi-chat');
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('volkAi.fixCode', () => {
      vscode.commands.executeCommand('workbench.view.extension.volkAi-chat');
    }),
  );

  // Add status bar item
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(sparkle) VOLK AI';
  statusBarItem.command = 'volkAi.openChat';
  statusBarItem.tooltip = 'Open VOLK AI Chat';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Listen for agent events
  agentCore.on('permission:required', (request: { action: string }) => {
    vscode.window.showInformationMessage(
      `VOLK AI needs to ${request.action}`,
      'Allow',
      'Deny',
    ).then((selection) => {
      agentCore.resolvePermission(request.action, selection === 'Allow');
    });
  });

  agentCore.on('task:completed', (trace: { status: string; actions: unknown[] }) => {
    vscode.window.showInformationMessage(
      `VOLK AI task ${trace.status}: ${trace.actions.length} actions performed`,
    );
  });

  agentCore.on('log', (entry: { level: string; message: string; error?: Error }) => {
    const level = entry.level;
    const msg = `[VOLK AI] ${entry.message}`;
    if (level === 'error') console.error(msg, entry.error);
    else if (level === 'warn') console.warn(msg);
    else console.log(msg);
  });
}

export function deactivate(): void {
  console.warn('VOLK AI extension is now deactivated');
}
