import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import SftpClient from 'ssh2-sftp-client';
import { SftpConfig } from './config';
import { isIgnored } from './ignore';

// Sempre esclusi, anche se assenti da "ignore": un server ostile non deve poter scrivere hook o task nel workspace
const ALWAYS_IGNORED = ['.git', '.vscode'];

// Vero se il percorso relativo esce dalla radice (non basta startsWith('..'): esiste "..hidden")
export function isOutside(rel: string): boolean {
    return rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
}

export class Session {
    private disposed = false;
    private client: SftpClient | undefined;
    private mkdirQueue: Promise<unknown> = Promise.resolve();
    private readonly knownDirs = new Set<string>();
    // Hash dell'ultimo contenuto caricato per percorso relativo: serve a saltare i salvataggi senza modifiche
    private readonly uploadedHashes = new Map<string, string>();
    // Serializza upload e download dello stesso file: due salvataggi ravvicinati non devono finire fuori ordine
    private readonly fileQueues = new Map<string, Promise<unknown>>();
    // Incrementato a ogni cancellazione remota: un upload iniziato prima non deve reinserire il suo hash
    private cacheEpoch = 0;
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
        if (isOutside(rel)) {
            throw new Error(`File outside the workspace: ${localPath}`);
        }
        return rel.split(path.sep).join('/');
    }

    remoteFor(rel: string): string {
        return path.posix.join(this.cfg.remotePath, rel);
    }

    ignored(rel: string): boolean {
        // Mai trasferire la chiave privata, né in upload né in download
        if (path.resolve(this.root, ...rel.split('/')) === this.keyFile) {
            return true;
        }
        return isIgnored(rel, [...ALWAYS_IGNORED, ...this.cfg.ignore]);
    }

    dispose(): void {
        this.disposed = true;
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
                // Ampio: il prompt TOFU modale blocca l'handshake finché l'utente non risponde
                readyTimeout: 120000,
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
        // Sessione scartata durante la connessione (reload): chiudere invece di perdere il client
        if (this.disposed) {
            void client.end().catch(() => undefined);
            throw new Error('Session disposed');
        }
        client.on('close', () => {
            this.client = undefined;
            this.knownDirs.clear();
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

    // Serializza mkdir: due chiamate concorrenti sulla stessa cartella nuova fallirebbero
    private ensureDir(client: SftpClient, dir: string): Promise<void> {
        if (this.knownDirs.has(dir)) {
            return Promise.resolve();
        }
        const run = this.mkdirQueue.then(async () => {
            if (!this.knownDirs.has(dir)) {
                await client.mkdir(dir, true);
                this.knownDirs.add(dir);
            }
        });
        this.mkdirQueue = run.catch(() => undefined);
        return run;
    }

    private serial<T>(rel: string, fn: () => Promise<T>): Promise<T> {
        const prev = this.fileQueues.get(rel) ?? Promise.resolve();
        const run = prev.catch(() => undefined).then(fn);
        const tail = run.catch(() => undefined);
        this.fileQueues.set(rel, tail);
        void tail.then(() => {
            if (this.fileQueues.get(rel) === tail) {
                this.fileQueues.delete(rel);
            }
        });
        return run;
    }

    // Falso se il file reale (dopo i symlink) esce dal workspace, è la chiave o è un percorso escluso
    isSafeLocal(local: string): boolean {
        try {
            const realRoot = fs.realpathSync(this.root);
            const real = fs.realpathSync(local);
            const realRel = path.relative(realRoot, real);
            if (isOutside(realRel) || real === fs.realpathSync(this.keyFile)) {
                return false;
            }
            return !this.ignored(realRel.split(path.sep).join('/'));
        } catch {
            return false;
        }
    }

    async uploadFile(local: string, skipUnchanged = false): Promise<void> {
        const rel = this.relPosix(local);
        if (this.ignored(rel)) {
            return;
        }
        if (!this.isSafeLocal(local)) {
            this.log.warn(`Skipped ${rel}: resolves outside the workspace, to the private key or to an ignored path`);
            return;
        }
        const remote = this.remoteFor(rel);
        await this.serial(rel, async () => {
            try {
                // Hash e upload usano lo stesso buffer: la cache non può divergere dal contenuto inviato
                const data = fs.readFileSync(local);
                const hash = crypto.createHash('sha1').update(data).digest('hex');
                if (skipUnchanged && this.uploadedHashes.get(rel) === hash) {
                    this.log.info(`Unchanged, skipped ${rel}`);
                    return;
                }
                // Un upload fallito a metà può lasciare un file corrotto: l'hash vecchio non vale più
                this.uploadedHashes.delete(rel);
                const epoch = this.cacheEpoch;
                const client = await this.get();
                await this.ensureDir(client, path.posix.dirname(remote));
                await client.put(data, remote);
                if (epoch === this.cacheEpoch) {
                    this.uploadedHashes.set(rel, hash);
                }
            } catch (e) {
                throw new Error(`Upload failed for ${rel}: ${(e as Error).message}`);
            }
            this.log.info(`Uploaded ${rel}`);
        });
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
            await this.ensureDir(await this.get(), this.remoteFor(dirRel));
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
            await this.serial(rel, async () => {
                await client.fastGet(remote, local);
                // Il contenuto locale ora viene dal server: l'hash dell'ultimo upload non vale più
                this.uploadedHashes.delete(rel);
            });
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
        // Le cartelle in cache potrebbero non esistere più
        this.knownDirs.clear();
        this.cacheEpoch++;
        for (const key of this.uploadedHashes.keys()) {
            if (key === rel || key.startsWith(rel + '/')) {
                this.uploadedHashes.delete(key);
            }
        }
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
