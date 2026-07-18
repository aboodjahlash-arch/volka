/**
 * @ai-agent/agent-core - Agent runtime with planner-executor loop, LLM integration, and tool system
 */

import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import type {
  LLMProvider,
  LLMMessage,
  AgentTool,
  AgentExecutionTrace,
  AgentAction,
  AgentPlannerConfig,
  ConversationSession,
  ChatMessage,
  WorkspaceFile,
  SymbolInfo,
  PermissionRequest,
  AutonomousModeConfig,
  TelemetryEvent,
  StructuredLogEntry,
} from '@ai-agent/shared';

export class AgentCore extends EventEmitter {
  private llmProvider: LLMProvider;
  private tools: Map<string, AgentTool> = new Map();
  private db: Database.Database;
  private config: AgentPlannerConfig;
  private autonomousConfig: AutonomousModeConfig;
  private pendingPermissions: Map<string, PermissionRequest> = new Map();

  constructor(
    llmProvider: LLMProvider,
    dbPath: string,
    config: Partial<AgentPlannerConfig> = {},
  ) {
    super();
    this.llmProvider = llmProvider;
    this.db = new Database(dbPath);
    this.config = {
      maxSteps: config.maxSteps ?? 50,
      maxConsecutiveFailures: config.maxConsecutiveFailures ?? 3,
      verificationEnabled: config.verificationEnabled ?? true,
    };
    this.autonomousConfig = {
      enabled: false,
      scopeLimits: {
        allowedDirectories: [],
        allowedCommands: [],
        maxExecutionTime: 300_000,
      },
    };

    this.initializeDatabase();
  }

  private initializeDatabase(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      );

      CREATE TABLE IF NOT EXISTS execution_traces (
        id TEXT PRIMARY KEY,
        task TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        status TEXT NOT NULL,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS trace_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        input TEXT NOT NULL,
        output TEXT,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (trace_id) REFERENCES execution_traces(id)
      );

      CREATE TABLE IF NOT EXISTS workspace_index (
        path TEXT PRIMARY KEY,
        language TEXT NOT NULL,
        size INTEGER NOT NULL,
        last_modified INTEGER NOT NULL,
        symbols TEXT DEFAULT '[]',
        imports TEXT DEFAULT '[]',
        exports TEXT DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS telemetry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        duration INTEGER,
        tokens_used INTEGER,
        tool_calls INTEGER,
        success INTEGER,
        error TEXT,
        metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS permission_requests (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        tool TEXT NOT NULL,
        details TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        resolved INTEGER DEFAULT 0,
        granted INTEGER DEFAULT 0
      );
    `);
  }

  registerTool(tool: AgentTool): void {
    this.tools.set(tool.name, tool);
    this.emit('tool:registered', tool);
  }

  unregisterTool(toolName: string): void {
    this.tools.delete(toolName);
    this.emit('tool:unregistered', toolName);
  }

  getTools(): AgentTool[] {
    return [...this.tools.values()];
  }

  setAutonomousMode(config: AutonomousModeConfig): void {
    this.autonomousConfig = config;
    this.emit('autonomous:mode_changed', config);
  }

  async executeTask(task: string): Promise<AgentExecutionTrace> {
    const trace: AgentExecutionTrace = {
      id: crypto.randomUUID(),
      task,
      actions: [],
      startedAt: Date.now(),
      status: 'running',
    };

    this.logTelemetry({ type: 'task:started', timestamp: trace.startedAt, metadata: { task } });

    try {
      const steps = await this.decomposeTask(task);
      let consecutiveFailures = 0;

      for (const step of steps) {
        if (consecutiveFailures >= this.config.maxConsecutiveFailures) {
          throw new Error(`Exceeded max consecutive failures (${this.config.maxConsecutiveFailures})`);
        }

        const action = await this.executeStep(step, trace.actions);
        trace.actions.push(action);

        if (action.result && !action.result.success) {
          consecutiveFailures++;
          const replanResult = await this.replanOnFailure(task, trace.actions);
          if (replanResult) {
            continue;
          }
        } else {
          consecutiveFailures = 0;
          if (this.config.verificationEnabled) {
            const verified = await this.verifyStep(action);
            if (!verified) {
              trace.actions.push({
                tool: 'verification',
                input: { actionId: action.tool },
                timestamp: Date.now(),
                result: {
                  success: false,
                  output: 'Verification failed',
                },
              });
              consecutiveFailures++;
            }
          }
        }
      }

      trace.status = 'completed';
      trace.completedAt = Date.now();
      this.logTelemetry({
        type: 'task:completed',
        timestamp: trace.completedAt!,
        duration: trace.completedAt! - trace.startedAt,
        toolCalls: trace.actions.length,
        success: true,
      });
    } catch (error) {
      trace.status = 'failed';
      trace.completedAt = Date.now();
      trace.error = error instanceof Error ? error.message : String(error);
      this.logTelemetry({
        type: 'task:failed',
        timestamp: trace.completedAt,
        duration: trace.completedAt - trace.startedAt,
        toolCalls: trace.actions.length,
        success: false,
        error: trace.error,
      });
    }

    this.persistExecutionTrace(trace);
    this.emit('task:completed', trace);
    return trace;
  }

  private async decomposeTask(task: string): Promise<string[]> {
    const systemPrompt = `You are a task decomposition agent. Break down the following task into a sequence of executable steps.
Each step must be a single, specific action that can be performed by a tool.
Return the steps as a JSON array of strings, with no additional text.`;

    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: task },
    ];

    const { content } = await this.llmProvider.generate({ messages, temperature: 0.2 });

    try {
      const parsed = JSON.parse(content);
      return Array.isArray(parsed) ? parsed : [task];
    } catch {
      return [task];
    }
  }

  private async executeStep(step: string, previousActions: AgentAction[]): Promise<AgentAction> {
    const systemPrompt = `You are an AI coding agent. You have access to the following tools:
${[...this.tools.values()].map((t) => `- ${t.name}: ${t.description} (permission: ${t.permissionLevel})`).join('\n')}

You must respond with a JSON object containing:
1. "tool": the name of the tool to call
2. "input": the parameters for the tool
3. "reasoning": brief reasoning for this action

Previous actions: ${JSON.stringify(previousActions.slice(-5))}`;

    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: step },
    ];

    const { content } = await this.llmProvider.generate({ messages, temperature: 0.1 });

    let parsed: { tool: string; input: Record<string, unknown> };
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error(`Failed to parse agent response: ${content}`);
    }

    const tool = this.tools.get(parsed.tool);
    if (!tool) {
      throw new Error(`Unknown tool: ${parsed.tool}`);
    }

    // Check permission
    if (tool.permissionLevel === 'confirm_required' && !this.autonomousConfig.enabled) {
      const permissionRequest: PermissionRequest = {
        action: step,
        tool: parsed.tool,
        details: JSON.stringify(parsed.input),
        timestamp: Date.now(),
        resolved: false,
      };

      this.pendingPermissions.set(permissionRequest.action, permissionRequest);
      this.emit('permission:required', permissionRequest);

      throw new Error(`Permission required for ${parsed.tool}: ${step}`);
    }

    const action: AgentAction = {
      tool: parsed.tool,
      input: parsed.input,
      timestamp: Date.now(),
    };

    try {
      action.result = await tool.execute(parsed.input);
    } catch (error) {
      action.result = {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }

    this.logTelemetry({
      type: 'tool:executed',
      timestamp: Date.now(),
      toolCalls: 1,
      success: action.result.success,
      metadata: { tool: parsed.tool },
    });

    return action;
  }

  private async replanOnFailure(task: string, actions: AgentAction[]): Promise<boolean> {
    const systemPrompt = `The previous step failed. Analyze the actions taken and determine if the task can be completed with a different approach.
Respond with true if you can replan and continue, or false if the task is impossible.`;

    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Task: ${task}\nActions: ${JSON.stringify(actions)}` },
    ];

    const { content } = await this.llmProvider.generate({ messages, temperature: 0.2 });
    return content.toLowerCase().includes('true');
  }

  private async verifyStep(action: AgentAction): Promise<boolean> {
    if (!action.result) return false;
    return action.result.success;
  }

  private persistExecutionTrace(trace: AgentExecutionTrace): void {
    const insertTrace = this.db.prepare(
      'INSERT OR REPLACE INTO execution_traces (id, task, started_at, completed_at, status, error) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const insertAction = this.db.prepare(
      'INSERT INTO trace_actions (trace_id, tool_name, input, output, timestamp) VALUES (?, ?, ?, ?, ?)',
    );

    const transaction = this.db.transaction(() => {
      insertTrace.run(
        trace.id,
        trace.task,
        trace.startedAt,
        trace.completedAt ?? null,
        trace.status,
        trace.error ?? null,
      );

      for (const action of trace.actions) {
        insertAction.run(
          trace.id,
          action.tool,
          JSON.stringify(action.input),
          JSON.stringify(action.result),
          action.timestamp,
        );
      }
    });

    transaction();
  }

  // === Conversation / Chat Memory ===

  async createConversation(projectPath: string): Promise<ConversationSession> {
    const session: ConversationSession = {
      id: crypto.randomUUID(),
      projectPath,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.db
      .prepare('INSERT INTO conversations (id, project_path, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(session.id, session.projectPath, session.createdAt, session.updatedAt);

    return session;
  }

  async addMessage(conversationId: string, message: ChatMessage): Promise<void> {
    this.db
      .prepare(
        'INSERT INTO messages (conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?)',
      )
      .run(conversationId, message.role, message.content, message.timestamp);

    this.db
      .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
      .run(message.timestamp, conversationId);
  }

  async getConversation(conversationId: string): Promise<ConversationSession | null> {
    const row = this.db
      .prepare('SELECT * FROM conversations WHERE id = ?')
      .get(conversationId) as Record<string, unknown> | undefined;

    if (!row) return null;

    const messageRows = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp')
      .all(conversationId) as Array<Record<string, unknown>>;

    return {
      id: row.id as string,
      projectPath: row.project_path as string,
      messages: messageRows.map((msg) => ({
        role: msg.role as ChatMessage['role'],
        content: msg.content as string,
        timestamp: msg.timestamp as number,
      })),
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  // === Workspace Index ===

  indexFile(file: WorkspaceFile): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO workspace_index (path, language, size, last_modified, symbols, imports, exports)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        file.path,
        file.language,
        file.size,
        file.lastModified,
        JSON.stringify(file.symbols),
        JSON.stringify(file.imports),
        JSON.stringify(file.exports),
      );
  }

  getIndexedFile(path: string): WorkspaceFile | null {
    const row = this.db.prepare('SELECT * FROM workspace_index WHERE path = ?').get(path) as Record<
      string,
      unknown
    > | undefined;

    if (!row) return null;

    return {
      path: row.path as string,
      language: row.language as string,
      size: row.size as number,
      lastModified: row.last_modified as number,
      symbols: JSON.parse(row.symbols as string) as SymbolInfo[],
      imports: JSON.parse(row.imports as string) as string[],
      exports: JSON.parse(row.exports as string) as string[],
    };
  }

  // === Permission Management ===

  resolvePermission(action: string, granted: boolean): void {
    const request = this.pendingPermissions.get(action);
    if (request) {
      request.resolved = true;
      request.granted = granted;
      this.pendingPermissions.delete(action);
      this.emit('permission:resolved', request);
    }
  }

  // === Telemetry ===

  private logTelemetry(event: TelemetryEvent): void {
    this.db
      .prepare(
        `INSERT INTO telemetry (type, timestamp, duration, tokens_used, tool_calls, success, error, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.type,
        event.timestamp,
        event.duration ?? null,
        event.tokensUsed ?? null,
        event.toolCalls ?? null,
        event.success ? 1 : 0,
        event.error ?? null,
        JSON.stringify(event.metadata ?? {}),
      );

    this.emit('telemetry', event);
  }

  // === Logging ===

  log(entry: StructuredLogEntry): void {
    this.emit('log', entry);
  }

  // === Cleanup ===

  close(): void {
    this.db.close();
  }
}
