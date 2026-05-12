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
