import * as vscode from 'vscode';
import { DaemonConnection } from './client';
import type { DaemonMessage } from './protocol';

export interface DtermPtyOptions {
    sessionName: string;
    daemonScript: string;
    cwd?: string;
    shell?: string;
    shellArgs?: string[];
    env?: Record<string, string>;
    scrollbackLines?: number;
    suppressTitleUpdates?: boolean;
    log?: (line: string) => void;
}

export class DtermPseudoterminal implements vscode.Pseudoterminal {
    private writeEmitter = new vscode.EventEmitter<string>();
    private closeEmitter = new vscode.EventEmitter<number | void>();
    private nameEmitter = new vscode.EventEmitter<string>();
    private readyEmitter = new vscode.EventEmitter<void>();

    readonly onDidWrite = this.writeEmitter.event;
    readonly onDidClose = this.closeEmitter.event;
    readonly onDidChangeName = this.nameEmitter.event;
    readonly onDidReady = this.readyEmitter.event;

    private conn = new DaemonConnection();
    private opened = false;

    get ready(): boolean { return this.opened; }
    private failed = false;
    private pendingInput: string[] = [];
    private pendingResize: vscode.TerminalDimensions | undefined;
    private cols = 80;
    private rows = 24;

    readonly sessionName: string;
    lastFiredTitle: string | undefined;
    suppressTitleUpdates: boolean;

    constructor(private readonly opts: DtermPtyOptions) {
        this.sessionName = opts.sessionName;
        this.suppressTitleUpdates = opts.suppressTitleUpdates ?? false;
    }

    open(initialDimensions: vscode.TerminalDimensions | undefined): void {
        if (initialDimensions) {
            this.cols = initialDimensions.columns;
            this.rows = initialDimensions.rows;
        }
        void this.openAsync();
    }

    private async openAsync(): Promise<void> {
        try {
            await this.conn.connect(this.opts.daemonScript);
        } catch (e) {
            this.enterFailedState('daemon failed', (e as Error).message ?? String(e));
            return;
        }
        this.conn.on('message', (msg: DaemonMessage) => this.handleMessage(msg));
        this.conn.on('close', () => {
            if (this.opened) {
                this.closeEmitter.fire();
            } else if (!this.failed) {
                this.enterFailedState(
                    'daemon disconnected before session opened',
                    'check "dterm: Show daemon log" for the cause.',
                );
            }
        });

        if (this.opts.scrollbackLines !== undefined) {
            this.conn.send({ type: 'set_scrollback_lines', lines: this.opts.scrollbackLines });
        }
        this.conn.send({
            type: 'open',
            name: this.opts.sessionName,
            cols: this.cols,
            rows: this.rows,
            cwd: this.opts.cwd,
            env: this.opts.env,
            shell: this.opts.shell || undefined,
            shellArgs: this.opts.shellArgs,
        });
    }

    close(): void {
        if (this.opened) {
            this.conn.send({ type: 'detach' });
        }
        this.conn.close();
    }

    handleInput(data: string): void {
        if (this.failed) {
            this.closeEmitter.fire(1);
            return;
        }
        if (!this.opened) {
            this.pendingInput.push(data);
            return;
        }
        this.conn.send({ type: 'input', data: Buffer.from(data, 'utf8').toString('base64') });
    }

    private enterFailedState(headline: string, detail: string): void {
        this.failed = true;
        this.writeEmitter.fire(`\r\n\x1b[31m[dterm] ${headline}:\x1b[0m\r\n`);
        for (const line of detail.split('\n')) {
            this.writeEmitter.fire(`\x1b[31m  ${line}\x1b[0m\r\n`);
        }
        this.writeEmitter.fire(
            '\r\n\x1b[33mRun "dterm: Show daemon log" from the command palette for full output.\x1b[0m\r\n',
        );
        this.writeEmitter.fire('\x1b[33mPress any key to close this terminal.\x1b[0m\r\n');
    }

    resync(): void {
        if (!this.opened || this.failed) return;
        this.opts.log?.(`pty ${this.sessionName}: resync (cols=${this.cols}, rows=${this.rows})`);
        this.conn.send({ type: 'detach' });
        this.conn.send({
            type: 'open',
            name: this.opts.sessionName,
            cols: this.cols,
            rows: this.rows,
            cwd: this.opts.cwd,
            env: this.opts.env,
            shell: this.opts.shell || undefined,
            shellArgs: this.opts.shellArgs,
        });
    }

    setDimensions(dim: vscode.TerminalDimensions): void {
        this.cols = dim.columns;
        this.rows = dim.rows;
        if (!this.opened) {
            this.pendingResize = dim;
            return;
        }
        this.conn.send({ type: 'resize', cols: dim.columns, rows: dim.rows });
    }

    private handleMessage(msg: DaemonMessage): void {
        switch (msg.type) {
            case 'opened': {
                this.opened = true;
                if (msg.created) {
                    this.writeEmitter.fire(
                        `\x1b[2m\x1b[36m· dterm: persistent session "${msg.name}" — Ctrl+\\\\ to detach, close (X) to terminate\x1b[0m\r\n`,
                    );
                }
                if (this.pendingResize) {
                    this.conn.send({
                        type: 'resize',
                        cols: this.pendingResize.columns,
                        rows: this.pendingResize.rows,
                    });
                    this.pendingResize = undefined;
                }
                for (const data of this.pendingInput) {
                    this.conn.send({ type: 'input', data: Buffer.from(data, 'utf8').toString('base64') });
                }
                this.pendingInput.length = 0;
                this.readyEmitter.fire();
                return;
            }
            case 'output': {
                const text = Buffer.from(msg.data, 'base64').toString('utf8');
                this.writeEmitter.fire(text);
                return;
            }
            case 'process_name': {
                this.opts.log?.(`pty ${this.sessionName}: process_name="${msg.name}" suppress=${this.suppressTitleUpdates}`);
                if (this.suppressTitleUpdates) return;
                const display = `dterm: ${msg.name}`;
                this.lastFiredTitle = display;
                this.nameEmitter.fire(display);
                return;
            }
            case 'session_end': {
                this.closeEmitter.fire(msg.exitCode ?? 0);
                return;
            }
            case 'error': {
                this.writeEmitter.fire(
                    `\r\n\x1b[31m[dterm] ${msg.message}\x1b[0m\r\n`,
                );
                return;
            }
        }
    }
}
