// dterm-client: tiny UI-side companion to the main dterm workspace extension.
//
// The main extension's per-session metadata (label, viewColumn, panel-active,
// editor-active, etc.) lives in workspaceState, which for a workspace-kind
// extension is stored on the remote and shared across all clients connecting
// to that remote. That means two laptops SSH-ing into the same remote would
// otherwise step on each other's terminal layouts.
//
// This extension runs UI-side, mints a stable per-client UUID at first
// activation, persists it in globalState (which on the UI side lives in the
// client's local user-data dir), and exposes it via a cross-host command the
// main extension calls to scope its workspaceState keys per-client.
//
// All that and nothing else.

import * as vscode from 'vscode';
import * as crypto from 'crypto';

const CLIENT_ID_KEY = 'dterm.clientId';

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
    let clientId = ctx.globalState.get<string>(CLIENT_ID_KEY);
    if (!clientId || typeof clientId !== 'string' || clientId.length === 0) {
        clientId = crypto.randomUUID();
        await ctx.globalState.update(CLIENT_ID_KEY, clientId);
    }
    const id = clientId;
    ctx.subscriptions.push(
        vscode.commands.registerCommand('dterm-client.getClientId', () => id),
    );
}

export function deactivate(): void {
    // nothing to clean up.
}
