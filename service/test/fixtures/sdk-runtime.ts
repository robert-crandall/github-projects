import { writeFileSync } from 'node:fs';

const marker = process.argv[2]!;
process.on('SIGTERM', () => { writeFileSync(`${marker}.term`, 'ignored'); });
writeFileSync(marker, String(process.pid));
writeFileSync(`${marker}.environment`, JSON.stringify({
  keychainDisabled: process.env.COPILOT_DISABLE_KEYTAR ?? null,
  home: process.env.HOME, copilotHome: process.env.COPILOT_HOME,
}));
setInterval(() => {}, 1000);

if (process.argv[3] === 'respond') {
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
      const payload = JSON.stringify({
        jsonrpc: '2.0', id: message.id,
        result: { protocolVersion: 3, isAuthenticated: true, host: 'github.com' },
      });
      process.stdout.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
    }
  });
}
