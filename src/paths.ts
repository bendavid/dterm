import * as os from 'os';
import * as path from 'path';

function userTag(): string {
    const info = os.userInfo();
    if (typeof info.uid === 'number' && info.uid >= 0) return String(info.uid);
    return info.username || 'user';
}

export function socketPath(): string {
    if (process.platform === 'win32') {
        return `\\\\.\\pipe\\dterm-${userTag()}`;
    }
    const runtime = process.env.XDG_RUNTIME_DIR;
    if (runtime) return path.join(runtime, 'dterm', 'daemon.sock');
    return path.join(os.tmpdir(), `dterm-${userTag()}`, 'daemon.sock');
}

export function daemonLogPath(): string {
    return path.join(os.tmpdir(), `dterm-${userTag()}.log`);
}

export function envFileDir(): string {
    const runtime = process.env.XDG_RUNTIME_DIR;
    if (runtime) return path.join(runtime, 'dterm', 'env');
    return path.join(os.tmpdir(), `dterm-${userTag()}`, 'env');
}

export function envFilePath(sessionName: string): string {
    const safe = sessionName.replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(envFileDir(), `${safe}.sh`);
}
