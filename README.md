# ws-sftp

[Italiano](README.it.md)

VS Code extension to upload and download files over SFTP with **private key only** (no passphrase). Uses the common `.vscode/sftp.json` format.

## Configuration

`.vscode/sftp.json` (can be created with the `s-sftp: Create sftp.json` command):

```json
{
  "name": "my-server",
  "host": "your-host.example.com",
  "protocol": "sftp",
  "port": 22,
  "username": "your-username",
  "privateKeyPath": ".vscode/key",
  "remotePath": "/path/to/remote/dir/",
  "uploadOnSave": true,
  "deleteRemote": false,
  "ignore": [".vscode", ".git", "node_modules", "*.md"]
}
```

* `uploadOnSave`: upload files on save (skipped if the content is identical to the last one uploaded in the session), on creation (including paste and drag and drop) and on rename or move.
* `deleteRemote` (optional, default `false`): delete on the server the files and folders deleted locally. On rename or move it also removes the old path.
* `ignore`: simplified `.gitignore`-style patterns. Without `/` they match at any level; ignoring a folder excludes all its content. The `!` negation is not supported: the character is literal.
* `privateKeyPath`: relative to the workspace root.
* Multi-root workspaces: only the first folder is used (a warning is written to the log).

## Security rules

* `publickey` authentication only. The fields `password`, `passphrase`, `privateKey`, `agent`, `interactiveAuth`, `sshCustomAuth` and a `protocol` other than `sftp` make the configuration invalid.
* Key with a passphrase: rejected.
* On Linux and Mac the key must have `600` permissions: a warning is shown if they are more open.
* Host key: on first connection you are asked to confirm the SHA256 fingerprint (handshake timeout: 120 s). If the fingerprint changes, the connection is blocked.
* Remote deletion never touches the root of `remotePath`.
* `.git`, `.vscode` and the private key file are always excluded from transfers, even if not listed in `ignore`. Symlinks to files are uploaded only if the real file stays inside the workspace and is neither the key nor an excluded path.

## Commands

* `s-sftp: Upload to server`: file or folder (Explorer and editor context menu).
* `s-sftp: Download from server`: file or folder (Explorer and remote tree, also from the context menu). Asks for confirmation, showing the path, before overwriting local files.
* `s-sftp: Sync with server`: sync the whole workspace (title of the remote tree), choosing the direction (local to server, or server to local).
* `s-sftp: Sync: Local -> Server` and `s-sftp: Sync: Local <- Server`: same sync with the direction already chosen, for a folder (Explorer context menu) or for the whole workspace (palette). The comparison by size and date produces a preview in the log: new files, modified files and files present only on the destination. Nothing is touched before confirmation. Deleting the extra files is a separate button (permanent on the server, moved to the trash locally). Limitation: the date depends on the clocks of local machine and server.
* `s-sftp: Refresh Remote Tree`.
* `s-sftp: Create sftp.json`: creates the file in `.vscode` without overwriting an existing one.

## Development

```
npm install
npm run typecheck
npm run build        # dist/extension.js
npm run package      # .vsix file
```

## Credits

Inspired by [SFTP](https://github.com/Natizyskunk/vscode-sftp) by Natizyskunk.

## License

GPL-3.0-only. See `LICENSE`.
