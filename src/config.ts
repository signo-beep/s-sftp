import * as fs from 'fs';
import * as path from 'path';

export interface SftpConfig {
    name: string;
    host: string;
    port: number;
    username: string;
    privateKeyPath: string;
    remotePath: string;
    uploadOnSave: boolean;
    deleteRemote: boolean;
    ignore: string[];
}

export interface LoadedConfig {
    config: SftpConfig;
    keyFile: string;
    warnings: string[];
}

export class ConfigError extends Error {}

// Valori del template creato da init: la configurazione e rifiutata finche non vengono sostituiti
const PLACEHOLDERS: Record<string, string[]> = {
    host: ['your-host.example.com'],
    username: ['your-username', 'changeme', 'changme'],
    remotePath: ['/path/to/remote/dir'],
};

function rejectPlaceholder(field: string, value: string): void {
    if (PLACEHOLDERS[field].includes(value)) {
        throw new ConfigError(`sftp.json: replace the placeholder in "${field}" (${value})`);
    }
}

const KNOWN_FIELDS = new Set([
    'name', 'host', 'protocol', 'port', 'username', 'privateKeyPath',
    'remotePath', 'uploadOnSave', 'deleteRemote', 'ignore',
]);

// Campi che aprirebbero metodi di autenticazione diversi dalla sola chiave
const FORBIDDEN_FIELDS = [
    'password', 'passphrase', 'privateKey', 'agent', 'interactiveAuth', 'sshCustomAuth',
];

function requireString(raw: Record<string, unknown>, field: string): string {
    const value = raw[field];
    if (typeof value !== 'string' || value.trim() === '') {
        throw new ConfigError(`sftp.json: field "${field}" is missing or invalid`);
    }
    return value.trim();
}

export function loadConfig(root: string): LoadedConfig {
    const file = path.join(root, '.vscode', 'sftp.json');
    let raw: Record<string, unknown>;
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        throw new ConfigError(`sftp.json unreadable: ${(e as Error).message}`);
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new ConfigError('sftp.json: must contain a JSON object');
    }

    for (const field of FORBIDDEN_FIELDS) {
        if (field in raw) {
            throw new ConfigError(`sftp.json: field "${field}" is not allowed (private key without passphrase only)`);
        }
    }
    if (raw.protocol !== undefined && raw.protocol !== 'sftp') {
        throw new ConfigError('sftp.json: "protocol" must be "sftp"');
    }

    const host = requireString(raw, 'host');
    rejectPlaceholder('host', host);
    const username = requireString(raw, 'username');
    rejectPlaceholder('username', username);

    const port = raw.port === undefined ? 22 : Number(raw.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new ConfigError('sftp.json: invalid "port"');
    }

    const remoteRaw = requireString(raw, 'remotePath');
    if (!remoteRaw.startsWith('/')) {
        throw new ConfigError('sftp.json: "remotePath" must be an absolute path');
    }
    const remotePath = path.posix.normalize(remoteRaw).replace(/\/+$/, '') || '/';
    rejectPlaceholder('remotePath', remotePath);

    const ignore = raw.ignore === undefined ? [] : raw.ignore;
    if (!Array.isArray(ignore) || ignore.some((p) => typeof p !== 'string')) {
        throw new ConfigError('sftp.json: "ignore" must be a list of strings');
    }

    const privateKeyPath = requireString(raw, 'privateKeyPath');
    const keyFile = path.resolve(root, privateKeyPath);
    if (!fs.existsSync(keyFile) || !fs.statSync(keyFile).isFile()) {
        throw new ConfigError(`Private key not found: ${keyFile}`);
    }

    const warnings: string[] = [];
    for (const field of Object.keys(raw)) {
        if (!KNOWN_FIELDS.has(field)) {
            warnings.push(`sftp.json: unknown field "${field}" ignored`);
        }
    }
    // Permessi troppo aperti: ssh stesso rifiuta chiavi leggibili da altri
    if (process.platform !== 'win32') {
        const mode = fs.statSync(keyFile).mode & 0o777;
        if ((mode & 0o077) !== 0) {
            warnings.push(`Key ${keyFile} has permissions ${mode.toString(8)}: set 600 (chmod 600)`);
        }
    }

    return {
        config: {
            name: typeof raw.name === 'string' ? raw.name : 's-sftp',
            host,
            port,
            username,
            privateKeyPath,
            remotePath,
            uploadOnSave: raw.uploadOnSave === true,
            deleteRemote: raw.deleteRemote === true,
            ignore: ignore as string[],
        },
        keyFile,
        warnings,
    };
}
