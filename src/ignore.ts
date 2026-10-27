import { minimatch } from 'minimatch';

// Pattern in stile .gitignore semplificato:
// - senza "/" vale su qualsiasi segmento del percorso (ignorare una cartella esclude tutto il contenuto)
// - con "/" vale sul percorso relativo completo o su un suo prefisso
export function isIgnored(relPosix: string, patterns: string[]): boolean {
    const segments = relPosix.split('/').filter(Boolean);
    for (const raw of patterns) {
        const pattern = raw.replace(/^\/+|\/+$/g, '');
        if (pattern === '') {
            continue;
        }
        if (!pattern.includes('/')) {
            if (segments.some((s) => minimatch(s, pattern, { dot: true }))) {
                return true;
            }
            continue;
        }
        for (let i = 1; i <= segments.length; i++) {
            if (minimatch(segments.slice(0, i).join('/'), pattern, { dot: true })) {
                return true;
            }
        }
    }
    return false;
}
