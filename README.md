# s-sftp

Estensione VS Code per caricare e scaricare file via SFTP con **sola chiave privata** (senza passphrase). Alternativa semplificata a Natizyskunk SFTP, con lo stesso formato di `.vscode/sftp.json`.

## Configurazione

`.vscode/sftp.json` (creabile con il comando `s-sftp: Create sftp.json`):

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

* `deleteRemote` (opzionale, default `false`): cancellare sul server i file e le cartelle cancellati in locale.
* `ignore`: pattern in stile `.gitignore`. Senza `/` valgono su qualsiasi livello; ignorare una cartella esclude tutto il contenuto.
* `privateKeyPath`: relativo alla radice del workspace.

## Regole di sicurezza

* Solo autenticazione `publickey`. I campi `password`, `passphrase`, `privateKey`, `agent`, `interactiveAuth`, `sshCustomAuth` e un `protocol` diverso da `sftp` rendono la configurazione non valida.
* Chiave con passphrase: rifiutata.
* Su Linux e Mac la chiave deve avere permessi `600`: con permessi più aperti compare un avviso.
* Host key: alla prima connessione viene chiesta conferma dell'impronta SHA256. Se l'impronta cambia, la connessione viene bloccata.
* La cancellazione remota non tocca mai la radice di `remotePath`.

## Comandi

* `s-sftp: Upload`: file o cartella (menu contestuale di Explorer e editor).
* `s-sftp: Download`: file o cartella (Explorer e albero remoto).
* `s-sftp: Refresh Remote Tree`.
* `s-sftp: Create sftp.json`: crea il file in `.vscode` senza sovrascrivere quello esistente.

## Build

```
npm install
npm run typecheck
npm run build        # dist/extension.js
npm run package      # file .vsix
```

Installazione: `code --install-extension s-sftp-0.1.0.vsix`.

## Stato

Versione 0.1.0: typecheck e build riusciti, test dei pattern `ignore` fatto. Non provato contro un server SFTP reale né in VS Code.

Dipendenza `ssh2` 1.17: usa `util.types.isDate`, quindi non ha il problema `isDate is not a function` di Natizyskunk 1.16.3 su Node 23.
