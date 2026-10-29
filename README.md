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

* `uploadOnSave`: caricare i file al salvataggio, alla creazione (anche incolla o trascinamento) e alla rinomina o allo spostamento.
* `deleteRemote` (opzionale, default `false`): cancellare sul server i file e le cartelle cancellati in locale. Alla rinomina o allo spostamento rimuove anche il percorso vecchio.
* `ignore`: pattern in stile `.gitignore` semplificato. Senza `/` valgono su qualsiasi livello; ignorare una cartella esclude tutto il contenuto. La negazione `!` non è supportata: il carattere è letterale.
* `privateKeyPath`: relativo alla radice del workspace.
* Workspace multi-root: viene usata solo la prima cartella (avviso nel log).

## Regole di sicurezza

* Solo autenticazione `publickey`. I campi `password`, `passphrase`, `privateKey`, `agent`, `interactiveAuth`, `sshCustomAuth` e un `protocol` diverso da `sftp` rendono la configurazione non valida.
* Chiave con passphrase: rifiutata.
* Su Linux e Mac la chiave deve avere permessi `600`: con permessi più aperti compare un avviso.
* Host key: alla prima connessione viene chiesta conferma dell'impronta SHA256 (timeout dell'handshake: 120 s). Se l'impronta cambia, la connessione viene bloccata.
* La cancellazione remota non tocca mai la radice di `remotePath`.

## Comandi

* `s-sftp: Upload to server`: file o cartella (menu contestuale di Explorer e editor).
* `s-sftp: Download from server`: file o cartella (Explorer e albero remoto, anche dal menu contestuale). Chiede conferma, con il percorso, prima di sovrascrivere i file locali.
* `s-sftp: Sync with server`: sincronizzare una cartella (menu Explorer, titolo dell'albero remoto) o l'intero workspace. Si sceglie la direzione (locale verso server, o server verso locale), poi il confronto per dimensione e data produce un'anteprima nel log: file nuovi, modificati e presenti solo sulla destinazione. Nulla viene toccato prima della conferma. La cancellazione dei file extra è un pulsante separato (sul server definitiva, in locale va nel cestino). Limite: la data dipende dagli orologi di locale e server.
* `s-sftp: Refresh Remote Tree`.
* `s-sftp: Create sftp.json`: crea il file in `.vscode` senza sovrascrivere quello esistente.

## Build

```
npm install
npm run typecheck
npm run build        # dist/extension.js
npm run package      # file .vsix
```

Installazione: `code --install-extension s-sftp-0.2.0.vsix`.

`.vscodeignore` esclude `src`, `node_modules`, `*.zip`, `*.vsix` e `old_vsix` dal pacchetto.

## Stato

Versione 0.2.0: typecheck e build riusciti, test dei pattern `ignore` fatto. Revisione del codice applicata (chiusura connessioni durante il reload, `mkdir` serializzato, controllo dei percorsi fuori workspace, rinomina remota). Non provato contro un server SFTP reale né in VS Code.

Dipendenza `ssh2` 1.17: usa `util.types.isDate`, quindi non ha il problema `isDate is not a function` di Natizyskunk 1.16.3 su Node 23.
