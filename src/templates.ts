// Contenuto dei file creati dal comando "sSftp.init"

export const SFTP_JSON = `{
  "name": "my-server",
  "host": "your-host.example.com",
  "protocol": "sftp",
  "port": 22,
  "username": "your-username",
  "privateKeyPath": ".vscode/key",
  "remotePath": "/path/to/remote/dir/",
  "uploadOnSave": true,
  "deleteRemote": false,
  "ignore": [
    ".vscode",
    ".git",
    ".gitignore",
    "node_modules",
    "vendor",
    ".env.*",
    "*.code-workspace",
    ".phpunit*",
    "*.md"
  ]
}
`;
