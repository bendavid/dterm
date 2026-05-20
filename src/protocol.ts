export interface SessionPosition {
    viewColumn?: number;
    tabIndex?: number;
    panelIndex?: number;
}

export interface ClientSelection {
    active?: string;
    panelActive?: string;
    editorActive?: { [viewColumn: number]: string };
}

// Per-session layout info the daemon returns to a client in list_response.
// label is workspace-shared (one string per session, latest wins across
// clients). position is per-client -- the daemon stores Map<clientId, Position>
// per session and returns only the entry for the requesting clientId.
export interface SessionLayoutInfo {
    name: string;
    label?: string;
    position?: SessionPosition;
}

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
    // `list` request now optionally carries clientId and workspaceTag. When
    // both are provided, list_response includes per-session label + this
    // client's position for sessions matching the workspaceTag prefix, plus
    // the client's selection state for this workspace. Old callers without
    // either argument still get names back.
    | { type: 'list'; clientId?: string; workspaceTag?: string }
    | { type: 'kill'; name: string }
    | { type: 'detach' }
    | { type: 'set_scrollback_lines'; lines: number }
    | { type: 'shutdown' }
    | { type: 'get_pid' }
    | { type: 'version' }
    | { type: 'get_session_env'; name: string }
    // Layout RPCs. All scoped by clientId where per-client; label is per-
    // session and workspace-shared. workspaceTag scopes selection state to
    // a single workspace within the daemon's session universe.
    | { type: 'set_session_label'; name: string; label: string | null }
    | { type: 'set_session_position'; name: string; clientId: string; position: SessionPosition | null }
    | { type: 'set_client_selection'; clientId: string; workspaceTag: string; selection: Partial<ClientSelection> }
    | { type: 'clear_client_layout'; clientId: string; workspaceTag?: string }
    | { type: 'clear_all_layouts'; workspaceTag?: string };

export type DaemonMessage =
    | { type: 'opened'; name: string; cols: number; rows: number; created: boolean }
    | { type: 'output'; data: string }
    | { type: 'process_name'; name: string }
    | { type: 'sequence_title'; title: string }
    // `names` is kept for back-compat with the diagnostic command-line
    // callers that just want the live session list. `sessions` and
    // `selection` are populated only when the request supplied clientId.
    | { type: 'list_response'; names: string[]; sessions?: SessionLayoutInfo[]; selection?: ClientSelection }
    | { type: 'killed'; name: string }
    | { type: 'session_end'; name: string; exitCode?: number; signal?: number }
    | { type: 'version_response'; version: string }
    | { type: 'pid_response'; pid: number }
    | { type: 'session_env_response'; name: string; env: Record<string, string> }
    // Generic ack for the layout setters and clear commands. cleared is an
    // optional count for clear_*_layout summaries.
    | { type: 'layout_ack'; cleared?: number }
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
