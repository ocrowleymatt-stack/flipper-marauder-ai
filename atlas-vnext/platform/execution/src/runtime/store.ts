import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RunPodRuntime, RuntimeStateStore } from './types.ts';

export class MemoryRuntimeStateStore implements RuntimeStateStore {
  private value: RunPodRuntime | null;

  constructor(initial: RunPodRuntime | null = null) {
    this.value = initial;
  }

  async load(): Promise<RunPodRuntime | null> {
    return this.value ? structuredClone(this.value) : null;
  }

  async save(runtime: RunPodRuntime): Promise<void> {
    this.value = structuredClone(runtime);
  }
}

export class FileRuntimeStateStore implements RuntimeStateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<RunPodRuntime | null> {
    try {
      const raw = await readFile(this.path, 'utf8');
      return JSON.parse(raw) as RunPodRuntime;
    } catch {
      return null;
    }
  }

  async save(runtime: RunPodRuntime): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(runtime, null, 2)}\n`, 'utf8');
  }
}
