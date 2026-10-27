import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigError, loadConfig } from './config';
import { Session } from './client';
import { SFTP_JSON } from './templates';

interface RemoteItem {
    rel: string;
    isDir: boolean;
}

export function activate(context: vscode.ExtensionContext): void {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        return;
    }
    const root = folder.uri.fsPath;
    const log = vscode.window.createOutputChannel('s-sftp', { log: true });
    let session: Session | undefined;
    const treeChanged = new vscode.EventEmitter<void>();

    // Voce nella barra di stato: apre il canale Output con il log di upload e download
    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    statusItem.text = '$(cloud-upload) s-sftp';
    statusItem.tooltip = 'Show s-sftp log';
    statusItem.command = 'sSftp.showLog';

    const fail = (e: unknown): void => {
        const msg = (e as Error).message;
        log.error(msg);
        // Niente popup: mostrare il canale Output senza rubare il focus
        log.show(true);
    };

    const reload = (): void => {
        session?.dispose();
        session = undefined;
        void vscode.commands.executeCommand('setContext', 'sSftp.active', false);
        statusItem.hide();
        // L'icona nella barra laterale compare solo se sftp.json esiste (anche se non valido)
        const hasFile = fs.existsSync(path.join(root, '.vscode', 'sftp.json'));
        void vscode.commands.executeCommand('setContext', 'sSftp.hasConfig', hasFile);
        if (!hasFile) {
            treeChanged.fire();
            return;
        }
        try {
            const { config, keyFile, warnings } = loadConfig(root);
            for (const w of warnings) {
                log.warn(w);
                void vscode.window.showWarningMessage(`s-sftp: ${w}`);
            }
            session = new Session(config, root, keyFile, context.globalState, log);
            void vscode.commands.executeCommand('setContext', 'sSftp.active', true);
            statusItem.show();
        } catch (e) {
            fail(e instanceof ConfigError ? e : e);
        }
        treeChanged.fire();
    };

    const withSession = async (fn: (s: Session) => Promise<void>): Promise<void> => {
        if (!session) {
            void vscode.window.showWarningMessage('s-sftp: configuration missing or invalid');
            return;
        }
        try {
            await fn(session);
            // Aggiornare l'albero remoto dopo ogni operazione riuscita
            treeChanged.fire();
        } catch (e) {
            fail(e);
        }
    };

    // Albero remoto
    const tree: vscode.TreeDataProvider<RemoteItem> = {
        onDidChangeTreeData: treeChanged.event,
        getTreeItem(item) {
            const label = item.rel === '' ? '/' : path.posix.basename(item.rel);
            const node = new vscode.TreeItem(
                label,
                item.isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
            );
            node.contextValue = item.isDir ? 'remoteDir' : 'remoteFile';
            return node;
        },
        async getChildren(parent) {
            if (!session) {
                return [];
            }
            const s = session;
            const rel = parent?.rel ?? '';
            try {
                const entries = await (await s.get()).list(s.remoteFor(rel));
                return entries
                    .filter((e) => (e.type === 'd' || e.type === '-') && !/[\\/]/.test(e.name))
                    .map((e) => ({ rel: rel === '' ? e.name : `${rel}/${e.name}`, isDir: e.type === 'd' }))
                    .filter((i) => !s.ignored(i.rel))
                    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.rel.localeCompare(b.rel));
            } catch (e) {
                fail(e);
                return [];
            }
        },
    };

    // Percorso locale da un argomento di comando: Uri (explorer/editor) oppure editor attivo
    const targetUri = (arg?: vscode.Uri): vscode.Uri | undefined =>
        arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;

    const view = vscode.window.createTreeView('sSftpRemote', { treeDataProvider: tree });

    // Autorefresh: aggiornare l'albero solo se visibile, con debounce per limitare le chiamate SFTP
    let refreshTimer: NodeJS.Timeout | undefined;
    const scheduleRefresh = (): void => {
        if (!session || !view.visible) {
            return;
        }
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => treeChanged.fire(), 300);
    };

    context.subscriptions.push(
        log,
        view,
        view.onDidChangeVisibility((e) => {
            if (e.visible) {
                scheduleRefresh();
            }
        }),
        vscode.window.onDidChangeActiveTextEditor(scheduleRefresh),
        { dispose: () => clearTimeout(refreshTimer) },

        vscode.commands.registerCommand('sSftp.init', () => {
            const dir = path.join(root, '.vscode');
            fs.mkdirSync(dir, { recursive: true });
            const created: string[] = [];
            const skipped: string[] = [];
            // Non sovrascrive mai file esistenti
            for (const [name, content] of [['sftp.json', SFTP_JSON]] as const) {
                const file = path.join(dir, name);
                if (fs.existsSync(file)) {
                    skipped.push(name);
                } else {
                    fs.writeFileSync(file, content, { flag: 'wx' });
                    created.push(name);
                }
            }
            void vscode.window.showInformationMessage(
                `s-sftp: created [${created.join(', ')}], already present [${skipped.join(', ')}]. ` +
                'Set "username" and copy the key to .vscode/key.',
            );
        }),

        vscode.commands.registerCommand('sSftp.upload', (arg?: vscode.Uri) =>
            withSession(async (s) => {
                const uri = targetUri(arg);
                if (!uri) {
                    return;
                }
                const n = await s.uploadPath(uri.fsPath);
                log.info(`Upload complete: ${n} file(s)`);
                vscode.window.setStatusBarMessage(`s-sftp: ${n} file(s) uploaded`, 3000);
            }),
        ),

        vscode.commands.registerCommand('sSftp.download', (arg?: vscode.Uri | RemoteItem) =>
            withSession(async (s) => {
                let rel: string;
                if (arg && !(arg instanceof vscode.Uri)) {
                    rel = arg.rel;
                } else {
                    const uri = targetUri(arg);
                    if (!uri) {
                        return;
                    }
                    rel = s.relPosix(uri.fsPath);
                }
                const n = await s.downloadPath(rel);
                log.info(`Download complete: ${n} file(s)`);
                vscode.window.setStatusBarMessage(`s-sftp: ${n} file(s) downloaded`, 3000);
            }),
        ),

        vscode.commands.registerCommand('sSftp.refresh', () => treeChanged.fire()),
        vscode.commands.registerCommand('sSftp.showLog', () => log.show()),
        // Cancellazione manuale sul server (solo remoto), con conferma modale
        vscode.commands.registerCommand('sSftp.deleteRemote', async (arg?: RemoteItem) => {
            const item = arg ?? view.selection[0];
            if (!item || item.rel === '') {
                return;
            }
            const answer = await vscode.window.showWarningMessage(
                `Delete ${item.isDir ? 'folder' : 'file'} "${item.rel}" on the server? This cannot be undone.`,
                { modal: true },
                'Delete',
            );
            if (answer !== 'Delete') {
                return;
            }
            await withSession((s) => s.deleteRemoteRel(item.rel));
        }),
        statusItem,

        vscode.workspace.onDidSaveTextDocument((doc) => {
            if (!session?.cfg.uploadOnSave || doc.uri.scheme !== 'file') {
                return;
            }
            const file = doc.uri.fsPath;
            if (path.relative(root, file).startsWith('..')) {
                return;
            }
            void withSession((s) => s.uploadFile(file));
        }),

        // Creazione (anche incolla o trascinamento) di file e cartelle: stessa regola di uploadOnSave
        vscode.workspace.onDidCreateFiles((event) => {
            if (!session?.cfg.uploadOnSave) {
                return;
            }
            for (const uri of event.files) {
                if (uri.scheme === 'file' && !path.relative(root, uri.fsPath).startsWith('..')) {
                    void withSession(async (s) => {
                        await s.uploadPath(uri.fsPath);
                    });
                }
            }
        }),

        vscode.workspace.onDidDeleteFiles((event) => {
            if (!session?.cfg.deleteRemote) {
                return;
            }
            for (const uri of event.files) {
                if (uri.scheme === 'file' && !path.relative(root, uri.fsPath).startsWith('..')) {
                    void withSession((s) => s.deleteRemote(uri.fsPath));
                }
            }
        }),
    );

    // Ricarica la configurazione quando sftp.json cambia
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '.vscode/sftp.json'));
    watcher.onDidChange(reload);
    watcher.onDidCreate(reload);
    watcher.onDidDelete(reload);
    context.subscriptions.push(watcher, { dispose: () => session?.dispose() });

    reload();
}

export function deactivate(): void {}
