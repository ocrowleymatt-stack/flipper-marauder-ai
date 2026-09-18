export const STAGING_PORT: number;
export const MANAGED_CONTAINER: string;

export interface Occupancy {
  portBound: boolean;
  managedPublishesPort: boolean;
}

export interface Decision {
  action: 'install' | 'update' | 'abort';
  reason: string;
}

export function decideStagingPort(occupancy: Occupancy): Decision;
export function localAddressBindsPort(localAddress: string | undefined, port: number): boolean;
export function ssOutputBindsPort(ssOutput: string, port: number): boolean;
export function dockerInspectPublishesHostPort(inspect: unknown, hostPort: number): boolean;
export function defaultReadSs(): string;
export function defaultInspectContainer(name: string): unknown;
export function probeOccupancy(options?: {
  port?: number;
  containerName?: string;
  readSs?: () => string;
  inspectContainer?: (name: string) => unknown;
}): Occupancy;
