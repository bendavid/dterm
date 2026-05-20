import * as os from 'os';
import * as path from 'path';

function userTag(): string {
    const info = os.userInfo();
    if (typeof info.uid === 'number' && info.uid >= 0) return String(info.uid);
    return info.username || 'user';
}

// Optional instance namespace, read from DTERM_INSTANCE in the process env.
// The extension sets this from the dterm.instanceId setting (or auto-detects
// from ExtensionMode.Development); the daemon inherits it via spawn env.
// Empty = the default "prod" instance.
export function instanceId(): string {
    const raw = (process.env.DTERM_INSTANCE || '').trim();
    if (!raw) return '';
    // Allow only filename-safe characters; cap to keep paths short.
    return raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
}

// Directory/socket leaf name -- "dterm" for the default instance,
// "dterm-<inst>" for a named one. Used to keep the dev and prod daemons
// on disjoint sockets, log files, and agent dirs so an F5 dev window and
// the marketplace install can run side by side.
function leaf(): string {
    const inst = instanceId();
    return inst ? `dterm-${inst}` : 'dterm';
}

// Session-name prefix shared by extension (allocation) and daemon (filter).
// "vscode-<tag>-" for the default instance, "vscode-<inst>-<tag>-" otherwise.
// Kept here (rather than in protocol.ts) so the daemon and extension agree
// on the format from the same source of truth.
export function sessionPrefix(workspaceTag: string): string {
    const inst = instanceId();
    return inst ? `vscode-${inst}-${workspaceTag}-` : `vscode-${workspaceTag}-`;
}

export function socketPath(): string {
    if (process.platform === 'win32') {
        return `\\\\.\\pipe\\${leaf()}-${userTag()}`;
    }
    const runtime = process.env.XDG_RUNTIME_DIR;
    if (runtime) return path.join(runtime, leaf(), 'daemon.sock');
    return path.join(os.tmpdir(), `${leaf()}-${userTag()}`, 'daemon.sock');
}

export function daemonLogPath(): string {
    return path.join(os.tmpdir(), `${leaf()}-${userTag()}.log`);
}

export function agentDir(workspaceTag: string): string {
    const safe = workspaceTag.replace(/[^a-zA-Z0-9._-]/g, '_');
    const runtime = process.env.XDG_RUNTIME_DIR;
    if (runtime) return path.join(runtime, leaf(), 'agent', safe);
    return path.join(os.tmpdir(), `${leaf()}-${userTag()}`, 'agent', safe);
}
