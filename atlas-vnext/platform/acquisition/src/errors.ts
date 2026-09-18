export const GENERIC_DENY = 'Permission denied.';

export class AcquisitionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400,
  ) {
    super(message);
    this.name = 'AcquisitionError';
  }
}

/**
 * Device control is not implemented. Callers must hold `device.control`;
 * this error exists so a missing implementation cannot silently broaden access.
 */
export class DeviceControlNotImplementedError extends Error {
  readonly code = 'device_control_not_implemented';
  readonly httpStatus = 501;

  constructor(message = 'Device control is not implemented.') {
    super(message);
    this.name = 'DeviceControlNotImplementedError';
  }
}
