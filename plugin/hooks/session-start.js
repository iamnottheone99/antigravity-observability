#!/usr/bin/env node

/**
 * SessionStart Hook for Agent Observability
 * Injects session notice announcing active observability, telemetry, and loop radar monitoring.
 */

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      resolve(data);
    });
  });
}

async function main() {
  await readStdin();

  const response = {
    injectSteps: [
      {
        systemMessage: {
          systemMessage:
            'agent-observability active: Live session telemetry, loop detection, and token economics are monitored in real time.',
        },
      },
    ],
  };

  process.stdout.write(JSON.stringify(response) + '\n');
}

main().catch(() => {
  process.stdout.write(JSON.stringify({}) + '\n');
});
