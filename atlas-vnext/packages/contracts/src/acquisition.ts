import { z } from 'zod';

const structuredFailureSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  at: z.string(),
});

/**
 * Shared acquisition contracts. Local data enters Atlas through this substrate:
 * source → acquisition → immutable original → cryptographic hash →
 * acquisition manifest → deterministic extraction → CAS/index.
 * Evidential objects are a later consumer; this is not Investigation storage.
 */

export const acquisitionSourceKindSchema = z.enum([
  'phone_export',
  'macos_export',
  'windows_export',
  'disk_image',
  'directory',
  'backup',
  'photo_library',
  'messages',
  'call_records',
  'browser_history',
  'location_export',
  'documents',
  'other',
]);
export type AcquisitionSourceKind = z.infer<typeof acquisitionSourceKindSchema>;

export const acquisitionStatusSchema = z.enum(['pending', 'hashing', 'accepted', 'failed', 'superseded']);
export type AcquisitionStatus = z.infer<typeof acquisitionStatusSchema>;

const sha256HexSchema = z.string().length(64).regex(/^[0-9a-f]{64}$/);

export const acquisitionEntrySchema = z.object({
  path: z.string().min(1),
  sha256: sha256HexSchema,
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  kind: z.string().min(1),
});
export type AcquisitionEntry = z.infer<typeof acquisitionEntrySchema>;

export const acquisitionManifestSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  workspaceId: z.string().min(1),
  sourceKind: acquisitionSourceKindSchema,
  title: z.string().min(1),
  originalCasHash: sha256HexSchema,
  sizeBytes: z.number().int().nonnegative(),
  acquiredAt: z.string().min(1),
  acquiredFrom: z.string().min(1),
  itemCount: z.number().int().nonnegative(),
  entries: z.array(acquisitionEntrySchema),
  status: acquisitionStatusSchema,
  failure: structuredFailureSchema.nullable(),
  generation: z.number().int().nonnegative(),
});
export type AcquisitionManifest = z.infer<typeof acquisitionManifestSchema>;

export const acquisitionItemSchema = z.object({
  path: z.string().min(1),
  mimeType: z.string().min(1).optional(),
  kind: z.string().min(1).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  sha256: sha256HexSchema.optional(),
});
export type AcquisitionItem = z.infer<typeof acquisitionItemSchema>;

export const acquisitionPlanSchema = z.object({
  projectId: z.string().min(1).optional(),
  sourceKind: acquisitionSourceKindSchema,
  title: z.string().min(1),
  acquiredFrom: z.string().min(1),
  items: z.array(acquisitionItemSchema).min(1),
  generation: z.number().int().nonnegative().optional(),
});
export type AcquisitionPlan = z.infer<typeof acquisitionPlanSchema>;

/**
 * Capability-gated device control port. Every method requires `device.control`
 * and must never silently broaden access (no ADB, no remote shells, no host
 * filesystem walks). Implementations must throw
 * `DeviceControlNotImplementedError`; this interface is not a licence to probe.
 */
export interface DeviceControlPort {
  /** Requires capability `device.control`. Must never silently broaden access. */
  connect(input: { locator: string }): Promise<never>;
  /** Requires capability `device.control`. Must never silently broaden access. */
  listDevices(): Promise<never>;
  /** Requires capability `device.control`. Must never silently broaden access. */
  pullExport(input: { locator: string }): Promise<never>;
}
