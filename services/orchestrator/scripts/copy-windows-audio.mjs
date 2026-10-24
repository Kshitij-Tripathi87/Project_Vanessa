import { cp, mkdir } from 'node:fs/promises';
const destination = new URL('../dist/agents/windows-audio/', import.meta.url);
await mkdir(destination, { recursive: true });
await cp(new URL('../src/agents/windows-audio/', import.meta.url), destination, { recursive: true });
