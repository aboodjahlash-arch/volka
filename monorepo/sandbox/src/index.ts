/**
 * @ai-agent/sandbox - Docker-based sandbox management for isolated code execution
 */

import Docker from 'dockerode';
import type { SandboxConfig, SandboxSession, SandboxExecResult } from '@ai-agent/shared';
import { EventEmitter } from 'node:events';

export class SandboxManager extends EventEmitter {
  private docker: Docker;
  private sessions: Map<string, SandboxSession> = new Map();

  constructor() {
    super();
    this.docker = new Docker();
  }

  async createSession(config: SandboxConfig): Promise<SandboxSession> {
    const session: SandboxSession = {
      id: crypto.randomUUID(),
      config,
      createdAt: Date.now(),
      status: 'creating',
    };

    this.sessions.set(session.id, session);
    this.emit('session:created', session);

    try {
      const container = await this.docker.createContainer({
        Image: config.image,
        Cmd: ['/bin/sh', '-c', 'tail -f /dev/null'],
        HostConfig: {
          CpuPeriod: 100000,
          CpuQuota: config.cpuLimit * 100000,
          Memory: config.memoryLimit * 1024 * 1024,
          Binds: [`${config.workingDirectory}:/workspace`],
        },
        Env: Object.entries(config.environmentVariables).map(
          ([key, value]) => `${key}=${value}`,
        ),
        WorkingDir: '/workspace',
        Tty: false,
        OpenStdin: false,
      });

      await container.start();
      session.status = 'running';
      this.emit('session:started', session);

      return session;
    } catch (error) {
      session.status = 'failed';
      this.emit('session:error', { session, error });
      throw error;
    }
  }

  async execCommand(
    sessionId: string,
    command: string,
    timeout?: number,
  ): Promise<SandboxExecResult> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'running') {
      throw new Error(`Session ${sessionId} is not running`);
    }

    const container = this.docker.getContainer(sessionId);
    const exec = await container.exec({
      Cmd: ['/bin/sh', '-c', command],
      AttachStdout: true,
      AttachStderr: true,
    });

    const startTime = Date.now();
    const timeoutMs = timeout ?? session.config.timeout;

    const result = await new Promise<SandboxExecResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Command execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      exec.start({ Detach: false, Tty: false }, (error, stream) => {
        if (error) {
          clearTimeout(timer);
          reject(error);
          return;
        }

        let stdout = '';
        let stderr = '';

        stream!.on('data', (chunk: Buffer) => {
          const output = chunk.toString('utf-8');
          stdout += output;
        });

        stream!.on('error', (err: Error) => {
          stderr += err.message;
        });

        stream!.on('end', () => {
          clearTimeout(timer);
          resolve({
            exitCode: 0,
            stdout,
            stderr,
            duration: Date.now() - startTime,
          });
        });
      });
    });

    this.emit('command:executed', { sessionId, command, result });
    return result;
  }

  async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    try {
      const container = this.docker.getContainer(sessionId);
      await container.stop();
      await container.remove();
      session.status = 'stopped';
      this.sessions.delete(sessionId);
      this.emit('session:destroyed', session);
    } catch (error) {
      this.emit('session:error', { session, error });
      throw error;
    }
  }

  getSession(sessionId: string): SandboxSession | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): SandboxSession[] {
    return [...this.sessions.values()];
  }
}
