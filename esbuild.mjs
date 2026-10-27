import { build } from 'esbuild';

// ssh2 carica moduli nativi opzionali in try/catch: si escludono dal bundle
await build({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: 'dist/extension.js',
    external: ['vscode', 'cpu-features'],
    loader: { '.node': 'empty' },
    sourcemap: true,
    logLevel: 'info',
});
