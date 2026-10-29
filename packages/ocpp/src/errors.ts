import type { Payload } from './framing.ts';

/** The CALLERROR codes OCPP-J 1.6 defines. "Occurence" is the spec's own spelling; match it exactly. */
export const OCPP16_ERROR_CODES = [
  'NotImplemented',
  'NotSupported',
  'InternalError',
  'ProtocolError',
  'SecurityError',
  'FormationViolation',
  'PropertyConstraintViolation',
  'OccurenceConstraintViolation',
  'TypeConstraintViolation',
  'GenericError',
] as const;

export type OcppErrorCode = (typeof OCPP16_ERROR_CODES)[number];

/** The other side answered one of our CALLs with a CALLERROR. */
export class OcppCallError extends Error {
  readonly errorCode: string;
  readonly details: Payload;

  constructor(errorCode: string, description: string, details: Payload = {}) {
    super(description ? `${errorCode}: ${description}` : errorCode);
    this.name = 'OcppCallError';
    this.errorCode = errorCode;
    this.details = details;
  }
}
