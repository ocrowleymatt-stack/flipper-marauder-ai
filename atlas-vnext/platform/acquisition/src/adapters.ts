import type { AcquisitionItem, AcquisitionPlan, AcquisitionSourceKind, DeviceControlPort } from '@atlas-vnext/contracts';
import { sanitiseRelPath } from '@atlas-vnext/files';
import { AcquisitionError, DeviceControlNotImplementedError } from './errors.ts';

export interface SuppliedAcquisitionItem {
  path: string;
  bytes: Uint8Array;
  mime?: string;
  kind?: string;
}

export interface PreparedAcquisition {
  plan: AcquisitionPlan;
  items: SuppliedAcquisitionItem[];
}

function assertCallerSuppliedBytes(item: SuppliedAcquisitionItem, adapter: string): void {
  if (!(item.bytes instanceof Uint8Array) || item.bytes.byteLength < 0) {
    throw new AcquisitionError('malformed', `${adapter} requires caller-supplied bytes; host filesystem crawl is refused.`);
  }
  try {
    sanitiseRelPath(item.path);
  } catch {
    throw new AcquisitionError(
      'malformed',
      `${adapter} accepts explicit relative paths only; absolute or traversal paths are refused.`,
    );
  }
}

function toPlan(
  sourceKind: AcquisitionSourceKind,
  title: string,
  acquiredFrom: string,
  items: SuppliedAcquisitionItem[],
): PreparedAcquisition {
  const planItems: AcquisitionItem[] = items.map((item) => ({
    path: sanitiseRelPath(item.path),
    mimeType: item.mime,
    kind: item.kind,
    sizeBytes: item.bytes.byteLength,
  }));
  return {
    plan: {
      sourceKind,
      title,
      acquiredFrom,
      items: planItems,
    },
    items: items.map((item) => ({
      path: sanitiseRelPath(item.path),
      bytes: item.bytes,
      mime: item.mime,
      kind: item.kind,
    })),
  };
}

/**
 * Directory trees must be supplied by the caller as relative path + bytes pairs.
 * This adapter never calls `readdir`, `stat`, or walks a host root.
 */
export class DirectoryAdapter {
  prepare(input: { title?: string; acquiredFrom?: string; entries: SuppliedAcquisitionItem[] }): PreparedAcquisition {
    if (!input.entries?.length) {
      throw new AcquisitionError('malformed', 'Directory acquisition requires caller-supplied entries.');
    }
    for (const entry of input.entries) assertCallerSuppliedBytes(entry, 'DirectoryAdapter');
    return toPlan('directory', input.title?.trim() || 'Directory export', input.acquiredFrom?.trim() || 'caller', input.entries);
  }
}

function archiveBlobMime(filename?: string, declared?: string): string {
  if (declared?.trim()) return declared.trim();
  const name = (filename ?? '').toLowerCase();
  if (name.endsWith('.zip')) return 'application/zip';
  if (name.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

/**
 * Archive contents must arrive as caller-supplied entries (already unpacked bytes)
 * or as a single archive blob the caller already loaded. No host path is opened.
 */
export class ArchiveAdapter {
  prepare(input: {
    title?: string;
    acquiredFrom?: string;
    sourceKind?: Extract<AcquisitionSourceKind, 'backup' | 'disk_image' | 'other'>;
    entries?: SuppliedAcquisitionItem[];
    bytes?: Uint8Array;
    filename?: string;
    mime?: string;
  }): PreparedAcquisition {
    const entries: SuppliedAcquisitionItem[] = input.entries?.length
      ? input.entries
      : input.bytes
        ? [{ path: input.filename?.trim() || 'archive.bin', bytes: input.bytes, mime: archiveBlobMime(input.filename, input.mime), kind: 'archive' }]
        : [];
    if (!entries.length) {
      throw new AcquisitionError('malformed', 'ArchiveAdapter requires caller-supplied bytes or entries.');
    }
    for (const entry of entries) assertCallerSuppliedBytes(entry, 'ArchiveAdapter');
    return toPlan(
      input.sourceKind ?? 'backup',
      input.title?.trim() || 'Archive export',
      input.acquiredFrom?.trim() || 'caller',
      entries,
    );
  }
}

/**
 * Message / call / browser exports are opaque caller-supplied payloads.
 * The adapter does not locate files on disk.
 */
export class MessageExportAdapter {
  prepare(input: {
    title?: string;
    acquiredFrom?: string;
    sourceKind?: Extract<AcquisitionSourceKind, 'messages' | 'call_records' | 'browser_history'>;
    filename?: string;
    bytes: Uint8Array;
    mime?: string;
  }): PreparedAcquisition {
    const item: SuppliedAcquisitionItem = {
      path: input.filename?.trim() || 'messages.json',
      bytes: input.bytes,
      mime: input.mime ?? 'application/json',
      kind: input.sourceKind ?? 'messages',
    };
    assertCallerSuppliedBytes(item, 'MessageExportAdapter');
    return toPlan(
      input.sourceKind ?? 'messages',
      input.title?.trim() || 'Message export',
      input.acquiredFrom?.trim() || 'caller',
      [item],
    );
  }
}

/**
 * Stub device-control port. Requires capability `device.control`.
 * Must never silently broaden access; every method throws.
 */
export class UnimplementedDeviceControl implements DeviceControlPort {
  async connect(_input: { locator: string }): Promise<never> {
    throw new DeviceControlNotImplementedError();
  }

  async listDevices(): Promise<never> {
    throw new DeviceControlNotImplementedError();
  }

  async pullExport(_input: { locator: string }): Promise<never> {
    throw new DeviceControlNotImplementedError();
  }
}

export const deviceControl: DeviceControlPort = new UnimplementedDeviceControl();
