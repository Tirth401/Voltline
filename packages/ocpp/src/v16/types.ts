import type { V16Action, V16_ACTIONS } from './actions.ts';
import type { V16RequestMap, V16ResponseMap } from './types.generated.ts';

export type * from './types.generated.ts';

export type V16Request<A extends V16Action> = V16RequestMap[A];
export type V16Response<A extends V16Action> = V16ResponseMap[A];

/** The actions a charger may send us (everything except CSMS-only commands). */
export type V16ChargerAction = {
  [A in V16Action]: (typeof V16_ACTIONS)[A] extends 'csms' ? never : A;
}[V16Action];

/** One entry of MeterValues.req's meterValue (StopTransaction's transactionData has the same shape). */
export type V16MeterValue = V16RequestMap['MeterValues']['meterValue'][number];
