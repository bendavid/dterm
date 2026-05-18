export type ClientMessage =
    | {
          type: 'open';
          name: string;
          cols: number;
          rows: number;
          cwd?: string;
          env?: Record<string, string>;
          shell?: string;
          shellArgs?: string[];
      }
    | { type: 'input'; data: string }
    | { type: 'resize'; cols: number; rows: number }
    | { type: 'list' }
    | { type: 'kill'; name: string }
    | { type: 'detach' }
    | { type: 'set_scrollback_lines'; lines: number }
    | { type: 'shutdown' }
    | { type: 'version' }
    | { type: 'get_session_env'; name: string };

export type DaemonMessage =
    | { type: 'opened'; name: string; cols: number; rows: number; created: boolean }
    | { type: 'output'; data: string }
    | { type: 'process_name'; name: string }
    | { type: 'list_response'; names: string[] }
    | { type: 'killed'; name: string }
    | { type: 'session_end'; name: string; exitCode?: number; signal?: number }
    | { type: 'version_response'; version: string }
    | { type: 'session_env_response'; name: string; env: Record<string, string> }
    | { type: 'error'; message: string };

export function encode(msg: ClientMessage | DaemonMessage): string {
    return JSON.stringify(msg) + '\n';
}

export class LineStream<T = unknown> {
    private buf = '';
    feed(chunk: Buffer | string): T[] {
        this.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        const out: T[] = [];
        let nl = this.buf.indexOf('\n');
        while (nl >= 0) {
            const line = this.buf.slice(0, nl);
            this.buf = this.buf.slice(nl + 1);
            if (line.length > 0) {
                try {
                    out.push(JSON.parse(line) as T);
                } catch {
                    // ignore malformed line
                }
            }
            nl = this.buf.indexOf('\n');
        }
        return out;
    }
}
