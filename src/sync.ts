import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Session } from './client';

type Direction = 'up' | 'down';

interface FileInfo {
    size: number;
    mtime: number;
}

interface Plan {
    fresh: string[];
    changed: string[];
    extra: string[];
}

// Tolleranza per orologi diversi tra locale e server
const MTIME_TOLERANCE_MS = 2000;

function localPath(s: Session, rel: string): string {
    return path.join(s.root, ...rel.split('/').filter(Boolean));
}

function listLocal(s: Session, rel: string, out: Map<string, FileInfo>): void {
    const dir = localPath(s, rel);
    if (!fs.existsSync(dir)) {
        return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
        if (s.ignored(childRel)) {
            continue;
        }
        if (entry.isDirectory()) {
            listLocal(s, childRel, out);
        } else if (entry.isFile()) {
            const st = fs.statSync(path.join(dir, entry.name));
            out.set(childRel, { size: st.size, mtime: st.mtimeMs });
        }
    }
}

async function listRemote(s: Session, rel: string, out: Map<string, FileInfo>): Promise<void> {
    const client = await s.get();
    for (const item of await client.list(s.remoteFor(rel))) {
        // Difesa da nomi remoti che uscirebbero dalla cartella locale
        if (item.name === '.' || item.name === '..' || /[\\/]/.test(item.name)) {
            continue;
        }
        const childRel = rel === '' ? item.name : `${rel}/${item.name}`;
        if (s.ignored(childRel)) {
            continue;
        }
        if (item.type === 'd') {
            await listRemote(s, childRel, out);
        } else if (item.type === '-') {
            out.set(childRel, { size: item.size, mtime: item.modifyTime });
        }
    }
}

// Confronto per dimensione e data: "changed" se la dimensione differisce o l'origine è più recente
function makePlan(src: Map<string, FileInfo>, dst: Map<string, FileInfo>): Plan {
    const plan: Plan = { fresh: [], changed: [], extra: [] };
    for (const [rel, a] of src) {
        const b = dst.get(rel);
        if (!b) {
            plan.fresh.push(rel);
        } else if (a.size !== b.size || a.mtime > b.mtime + MTIME_TOLERANCE_MS) {
            plan.changed.push(rel);
        }
    }
    for (const rel of dst.keys()) {
        if (!src.has(rel)) {
            plan.extra.push(rel);
        }
    }
    plan.fresh.sort();
    plan.changed.sort();
    plan.extra.sort();
    return plan;
}

// Sincronizzazione con anteprima: nulla viene toccato prima della conferma
export async function runSync(s: Session, log: vscode.LogOutputChannel, scopeRel: string): Promise<void> {
    const choice = await vscode.window.showQuickPick(
        [
            { label: 'Local to server', description: 'upload new and changed files', direction: 'up' as Direction },
            { label: 'Server to local', description: 'download new and changed files', direction: 'down' as Direction },
        ],
        { title: `s-sftp: sync ${scopeRel === '' ? 'whole workspace' : scopeRel}`, placeHolder: 'Choose the direction' },
    );
    if (!choice) {
        return;
    }
    const direction = choice.direction;

    const local = new Map<string, FileInfo>();
    const remote = new Map<string, FileInfo>();
    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 's-sftp: comparing' },
        async () => {
            listLocal(s, scopeRel, local);
            const client = await s.get();
            // Cartella assente sul server: nessun file remoto
            if ((await client.exists(s.remoteFor(scopeRel))) === 'd') {
                await listRemote(s, scopeRel, remote);
            }
        },
    );

    const plan = direction === 'up' ? makePlan(local, remote) : makePlan(remote, local);
    const total = plan.fresh.length + plan.changed.length;
    if (total === 0 && plan.extra.length === 0) {
        void vscode.window.showInformationMessage('s-sftp: already in sync');
        return;
    }

    const target = direction === 'up' ? 'server' : 'local';
    log.info(`Sync preview (${direction === 'up' ? 'local to server' : 'server to local'}):`);
    plan.fresh.forEach((rel) => log.info(`  new      ${rel}`));
    plan.changed.forEach((rel) => log.info(`  changed  ${rel}`));
    plan.extra.forEach((rel) => log.info(`  only on ${target}  ${rel}`));
    log.show(true);

    const deleteLabel = `Apply and delete ${plan.extra.length} on ${target}`;
    const buttons: string[] = [];
    if (total > 0) {
        buttons.push('Apply');
    }
    if (plan.extra.length > 0) {
        buttons.push(deleteLabel);
    }
    const answer = await vscode.window.showWarningMessage(
        `Sync ${direction === 'up' ? 'local to server' : 'server to local'}: ` +
            `${plan.fresh.length} new, ${plan.changed.length} changed, ${plan.extra.length} only on ${target}. ` +
            'Details in the s-sftp log.',
        { modal: true },
        ...buttons,
    );
    if (!answer) {
        return;
    }

    const removeExtra = answer === deleteLabel;
    const transfers = [...plan.fresh, ...plan.changed];
    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 's-sftp: syncing' },
        async (progress) => {
            let done = 0;
            for (const rel of transfers) {
                progress.report({ message: `${++done}/${transfers.length} ${rel}` });
                if (direction === 'up') {
                    await s.uploadFile(localPath(s, rel));
                } else {
                    await s.downloadPath(rel);
                }
            }
            if (removeExtra) {
                for (const rel of plan.extra) {
                    if (direction === 'up') {
                        await s.deleteRemoteRel(rel);
                    } else {
                        // Cestino: i file locali cancellati restano recuperabili
                        await vscode.workspace.fs.delete(vscode.Uri.file(localPath(s, rel)), { useTrash: true });
                    }
                }
            }
        },
    );
    log.info(`Sync complete: ${transfers.length} transferred, ${removeExtra ? plan.extra.length : 0} deleted`);
    vscode.window.setStatusBarMessage(`s-sftp: sync done (${transfers.length} file(s))`, 3000);
}
