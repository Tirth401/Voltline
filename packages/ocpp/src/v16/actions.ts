/** Who sends the CALL for an action: the charger, the CSMS (us), or either side. */
export type V16Sender = 'charger' | 'csms' | 'both';

/** Every action in the OCPP 1.6 core specification (security-whitepaper extensions excluded). */
export const V16_ACTIONS = {
  Authorize: 'charger',
  BootNotification: 'charger',
  DataTransfer: 'both',
  DiagnosticsStatusNotification: 'charger',
  FirmwareStatusNotification: 'charger',
  Heartbeat: 'charger',
  MeterValues: 'charger',
  StartTransaction: 'charger',
  StatusNotification: 'charger',
  StopTransaction: 'charger',
  CancelReservation: 'csms',
  ChangeAvailability: 'csms',
  ChangeConfiguration: 'csms',
  ClearCache: 'csms',
  ClearChargingProfile: 'csms',
  GetCompositeSchedule: 'csms',
  GetConfiguration: 'csms',
  GetDiagnostics: 'csms',
  GetLocalListVersion: 'csms',
  RemoteStartTransaction: 'csms',
  RemoteStopTransaction: 'csms',
  ReserveNow: 'csms',
  Reset: 'csms',
  SendLocalList: 'csms',
  SetChargingProfile: 'csms',
  TriggerMessage: 'csms',
  UnlockConnector: 'csms',
  UpdateFirmware: 'csms',
} as const satisfies Record<string, V16Sender>;

export type V16Action = keyof typeof V16_ACTIONS;
