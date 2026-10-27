import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import SftpClient from 'ssh2-sftp-client';
import { SftpConfig } from './config';
import { isIgnored } from './ignore';

export class Session {
    private client: SftpClient | undefined;
    private connecting: Promise<SftpClient> | undefined;

    constructor(
        readonly cfg: SftpConfig,
        readonly root: string,
        private readonly keyFile: string,
        private readonly store: vscode.Memento,
        private readonly log: vscode.LogOutputChannel,
    ) {}

    // Percorso relativo POSIX di un file locale rispetto alla radice del workspace
    relPosix(localPath: string): string {
        const rel = path.relative(this.root, localPath);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new Error(`File outside the workspace: ${localPath}`);
        }
        return rel.split(path.sep).join('/');
    }

    remoteFor(rel: string): string {
        return path.posix.join(this.cfg.remotePath, rel);
    }

    ignored(rel: string): boolean {
        return isIgnored(rel, this.cfg.ignore);
    }

    dispose(): void {
        void this.client?.end().catch(() => undefined);
        this.client = undefined;
    }

    async get(): Promise<SftpClient> {
        if (this.client) {
            return this.client;
        }
        if (!this.connecting) {
            this.connecting = this.connect().finally(() => {
                this.connecting = undefined;
            });
        }
        return this.connecting;
    }

    private async connect(): Promise<SftpClient> {
        const client = new SftpClient(this.cfg.name);
        this.log.info(`Connecting to ${this.cfg.username}@${this.cfg.host}:${this.cfg.port}`);
        try {
            await client.connect({
                host: this.cfg.host,
                port: this.cfg.port,
                username: this.cfg.username,
                privateKey: fs.readFileSync(this.keyFile),
                // Solo chiave: niente password, keyboard-interactive o agent
                authHandler: ['publickey'],
                tryKeyboard: false,
                readyTimeout: 15000,
                hostHash: 'sha256',
                hostVerifier: ((hash: string, verify: (ok: boolean) => void) => {
                    this.verifyHost(hash).then(verify, () => verify(false));
                }) as never,
            });
        } catch (e) {
            const msg = (e as Error).message;
            if (/encrypted|passphrase/i.test(msg)) {
                throw new Error('The private key has a passphrase: use a key without passphrase');
            }
            throw e;
        }
        client.on('close', () => {
            this.client = undefined;
        });
        this.client = client;
        return client;
    }

    // Impronta SHA256 in formato OpenSSH, memorizzata alla prima connessione (TOFU)
    private async verifyHost(hexHash: string): Promise<boolean> {
        const fingerprint = 'SHA256:' + Buffer.from(hexHash, 'hex').toString('base64').replace(/=+$/, '');
        const key = `hostkey:${this.cfg.host}:${this.cfg.port}`;
        const known = this.store.get<string>(key);
        if (known === fingerprint) {
            return true;
        }
        if (known) {
            this.log.warn(`Host fingerprint changed (${known} -> ${fingerprint})`);
            void vscode.window.showErrorMessage(
                `Host key of ${this.cfg.host} changed: connection blocked. Expected ${known}, received ${fingerprint}.`,
            );
            return false;
        }
        const answer = await vscode.window.showWarningMessage(
            `First connection to ${this.cfg.host}. Fingerprint: ${fingerprint}. Trust it?`,
            { modal: true },
            'Trust',
        );
        if (answer !== 'Trust') {
            return false;
        }
        await this.store.update(key, fingerprint);
        return true;
    }

    async uploadFile(local: string): Promise<void> {
        const rel = this.relPosix(local);
        if (this.ignored(rel)) {
            return;
        }
        const remote = this.remoteFor(rel);
        try {
            const client = await this.get();
            await client.mkdir(path.posix.dirname(remote), true);
            await client.fastPut(local, remote);
        } catch (e) {
            throw new Error(`Upload failed for ${rel}: ${(e as Error).message}`);
        }
        this.log.info(`Uploaded ${rel}`);
    }

    async uploadPath(local: string): Promise<number> {
        const stat = fs.statSync(local);
        if (stat.isFile()) {
            await this.uploadFile(local);
            return 1;
        }
        const dirRel = this.relPosix(local);
        if (dirRel !== '') {
            if (this.ignored(dirRel)) {
                return 0;
            }
            // Creare la cartella remota anche se vuota
            await (await this.get()).mkdir(this.remoteFor(dirRel), true);
            this.log.info(`Created remote folder ${dirRel}`);
        }
        let count = 0;
        for (const entry of fs.readdirSync(local, { withFileTypes: true })) {
            const child = path.join(local, entry.name);
            if (this.ignored(this.relPosix(child))) {
                continue;
            }
            if (entry.isDirectory() || entry.isFile()) {
                count += await this.uploadPath(child);
            }
        }
        return count;
    }

    async downloadPath(rel: string): Promise<number> {
        if (rel !== '' && this.ignored(rel)) {
            return 0;
        }
        const client = await this.get();
        const remote = this.remoteFor(rel);
        const local = path.join(this.root, ...rel.split('/').filter(Boolean));
        const type = await client.exists(remote);
        if (type === 'd') {
            fs.mkdirSync(local, { recursive: true });
            let count = 0;
            for (const item of await client.list(remote)) {
                // Difesa da nomi remoti che uscirebbero dalla cartella locale
                if (item.name === '.' || item.name === '..' || /[\\/]/.test(item.name)) {
                    continue;
                }
                if (item.type === 'd' || item.type === '-') {
                    count += await this.downloadPath(rel === '' ? item.name : `${rel}/${item.name}`);
                }
            }
            return count;
        }
        if (type === '-') {
            fs.mkdirSync(path.dirname(local), { recursive: true });
            await client.fastGet(remote, local);
            this.log.info(`Downloaded ${rel}`);
            return 1;
        }
        throw new Error(`Remote path not found: ${remote}`);
    }

    async deleteRemote(local: string): Promise<void> {
        await this.deleteRemoteRel(this.relPosix(local));
    }

    async deleteRemoteRel(rel: string): Promise<void> {
        // Mai cancellare la radice remota
        if (rel === '' || this.ignored(rel)) {
            return;
        }
        const client = await this.get();
        const remote = this.remoteFor(rel);
        const type = await client.exists(remote);
        if (type === 'd') {
            await client.rmdir(remote, true);
        } else if (type === '-') {
            await client.delete(remote);
        } else {
            return;
        }
        this.log.info(`Deleted remote ${rel}`);
    }
}
