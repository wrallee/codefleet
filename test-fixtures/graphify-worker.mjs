import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  process.stdout.write(`${JSON.stringify({
    id: request.id,
    result: `${process.pid}:${request.repositoryPath}:${request.query}`,
  })}\n`);
}
