import { writeFileSync } from 'node:fs';

const marker = process.argv[2]!;
process.on('SIGTERM', () => { writeFileSync(`${marker}.term`, 'ignored'); });
writeFileSync(marker, String(process.pid));
writeFileSync(`${marker}.environment`, JSON.stringify({
  keychainDisabled: process.env.COPILOT_DISABLE_KEYTAR ?? null,
  home: process.env.HOME, copilotHome: process.env.COPILOT_HOME,
}));
setInterval(() => {}, 1000);

if (process.argv[3] !== 'hang') {
  let buffer = Buffer.alloc(0);
  process.stdin.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const separator = buffer.indexOf('\r\n\r\n');
      if (separator < 0) return;
      const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, separator).toString())?.[1]);
      if (!Number.isSafeInteger(length) || length < 0) throw new Error('Invalid synthetic RPC frame');
      if (buffer.length < separator + 4 + length) return;
      const message = JSON.parse(buffer.subarray(separator + 4, separator + 4 + length).toString());
      buffer = buffer.subarray(separator + 4 + length);
      if (message.id === undefined) continue;
      const emit = (value: unknown) => {
        const payload = JSON.stringify(value);
        process.stdout.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
      };
      if (message.method === 'session.send' && process.argv[3] === 'send-reject') {
        emit({jsonrpc:'2.0',id:message.id,error:{code:-32603,message:'Synthetic send rejection'}});
        continue;
      }
      if (message.method === 'session.send' && ['session-answer','session-error'].includes(process.argv[3]!)) {
        const event = (type: string, data: unknown) => emit({jsonrpc:'2.0',method:'session.event',
          params:{sessionId:message.params.sessionId,event:{id:crypto.randomUUID(),timestamp:new Date().toISOString(),type,data}}});
        if (process.argv[3] === 'session-error') event('session.error',{message:'Synthetic error'});
        else {
          event('assistant.message',{content:'first'});
          event('session.idle',{mode:'autopilot'});
          event('assistant.message',{content:'final'});
          event('session.idle',{});
        }
      }
      const payload = JSON.stringify({
        jsonrpc: '2.0', id: message.id,
        result: { protocolVersion: 3, isAuthenticated: true, host: 'github.com', sessionId: message.params?.sessionId ?? 'synthetic-session', messageId: 'synthetic-message', success: true },
      });
      process.stdout.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
    }
  });
}
