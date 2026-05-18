// dterm-client: UI-side companion that hosts dterm's per-(workspace,client)
// terminal-layout state.
//
// The main dterm extension runs as a workspace-kind extension, so its
// workspaceState/globalState live on the remote in remote-SSH scenarios and
// are shared across every client that connects to that remote. Two laptops
// SSH-ing into the same remote would step on each other's terminal layouts
// (label, viewColumn, panel-active, per-editor-column active).
//
// This companion runs UI-side (extensionKind: "ui"), so its workspaceState is
// stored in the client's local user-data dir. The main extension proxies all
// state reads/writes through the three cross-host commands registered below,
// getting genuine per-client storage without any scoping prefix.

import * as vscode from 'vscode';

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
    ctx.subscriptions.push(
        vscode.commands.registerCommand(
            'dterm-client.state.get',
            (key: string) => ctx.workspaceState.get(key),
        ),
        vscode.commands.registerCommand(
            'dterm-client.state.update',
            (key: string, value: unknown) => ctx.workspaceState.update(key, value),
        ),
        vscode.commands.registerCommand(
            'dterm-client.state.keys',
            () => Array.from(ctx.workspaceState.keys()),
        ),
    );
}

export function deactivate(): void {
    // nothing to clean up.
}
