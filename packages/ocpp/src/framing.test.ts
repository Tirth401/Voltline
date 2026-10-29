import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  parseFrame,
  serializeCall,
  serializeCallError,
  serializeCallResult,
  type Payload,
} from './framing.ts';

describe('parseFrame', () => {
  it('reads the three OCPP-J message types', () => {
    expect(parseFrame('[2,"m1","Heartbeat",{}]')).toEqual({
      ok: true,
      frame: { type: 2, messageId: 'm1', action: 'Heartbeat', payload: {} },
    });
    expect(parseFrame('[3,"m1",{"currentTime":"2026-01-01T00:00:00Z"}]')).toEqual({
      ok: true,
      frame: { type: 3, messageId: 'm1', payload: { currentTime: '2026-01-01T00:00:00Z' } },
    });
    expect(parseFrame('[4,"m1","NotImplemented","nope",{}]')).toEqual({
      ok: true,
      frame: {
        type: 4,
        messageId: 'm1',
        errorCode: 'NotImplemented',
        errorDescription: 'nope',
        errorDetails: {},
      },
    });
  });

  it('rejects frames with no usable message ID, so there is nothing to answer', () => {
    for (const text of [
      'not json',
      '{"a":1}',
      '[2]',
      '[2,"","Heartbeat",{}]',
      '[2,7,"Heartbeat",{}]',
      `[2,"${'x'.repeat(37)}","Heartbeat",{}]`,
    ]) {
      const result = parseFrame(text);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.messageId).toBeUndefined();
    }
  });

  it('keeps the message ID of a malformed CALL, so it can be answered with a CALLERROR', () => {
    for (const text of [
      '[2,"m1","Heartbeat"]',
      '[2,"m1","Heartbeat",[]]',
      '[2,"m1",5,{}]',
      '[2,"m1","Heartbeat",{},"extra"]',
    ]) {
      expect(parseFrame(text)).toMatchObject({ ok: false, messageId: 'm1', messageType: 2 });
    }
  });

  it('rejects unknown message types', () => {
    expect(parseFrame('[5,"m1",{}]')).toMatchObject({ ok: false, messageId: 'm1' });
  });

  it('reads back exactly what the serializers write', () => {
    const messageId = fc.string({ minLength: 1, maxLength: 36 });
    const payload = fc.dictionary(fc.string(), fc.jsonValue()) as fc.Arbitrary<Payload>;
    fc.assert(
      fc.property(messageId, fc.string(), payload, (id, action, body) => {
        expect(parseFrame(serializeCall(id, action, body))).toEqual({
          ok: true,
          frame: {
            type: 2,
            messageId: id,
            action,
            payload: JSON.parse(JSON.stringify(body)) as Payload,
          },
        });
        expect(parseFrame(serializeCallResult(id, body))).toMatchObject({ ok: true });
        expect(parseFrame(serializeCallError(id, 'GenericError', 'why', body))).toMatchObject({
          ok: true,
        });
      }),
    );
  });
});
