import {
  OcppCallError,
  V16_ACTIONS,
  type V16Action,
  type V16Sender,
  type V16Validator,
} from '@voltline/ocpp';
import type { CommandOutcome, CommandRequest } from '@voltline/routing';
import type { ChargerConnection } from './connection.ts';

/**
 * Sends one command from the CSMS to a charger connected to this gateway: RemoteStartTransaction,
 * TriggerMessage and so on. The command and the charger's answer are both checked against the
 * official schemas (D-019, D-030).
 */
export async function runCommand(
  connection: ChargerConnection | undefined,
  request: CommandRequest,
  validator: V16Validator,
): Promise<CommandOutcome> {
  if (!connection) return { status: 'not-connected' };
  const sender = (V16_ACTIONS as Record<string, V16Sender | undefined>)[request.action];
  if (sender === undefined || sender === 'charger') {
    return { status: 'invalid', description: `${request.action} is not a command the CSMS sends` };
  }
  const action = request.action as V16Action;
  const valid = validator.request(action, request.payload);
  if (!valid.ok) return { status: 'invalid', description: valid.description };

  try {
    const result = await connection.call(action, request.payload);
    const answer = validator.response(action, result);
    if (!answer.ok) {
      return {
        status: 'charger-error',
        errorCode: 'FormationViolation',
        description: `the charger's answer broke the schema: ${answer.description}`,
      };
    }
    return { status: 'answered', result };
  } catch (error) {
    if (error instanceof OcppCallError) {
      return { status: 'charger-error', errorCode: error.errorCode, description: error.message };
    }
    const closed = error instanceof Error && error.message.startsWith('connection closed');
    return closed ? { status: 'not-connected' } : { status: 'timeout' };
  }
}
