#!/usr/bin/env node

import http from 'node:http';
import { pipeline } from 'node:stream/promises';

const listenPort = Number.parseInt(process.env.CUA_PROXY_PORT, 10);
const upstreamPort = Number.parseInt(process.env.CUA_UPSTREAM_PORT, 10);
let firstDocument = true;
const server = http.createServer(async (request, response) => {
  if (firstDocument && request.method === 'GET' && request.url === '/') {
    firstDocument = false;
    process.stdout.write('CHATMUX_DOCUMENT_REQUESTED\n');
  }
  const upstream = http.request({
    hostname: '127.0.0.1', port: upstreamPort, method: request.method,
    path: request.url, headers: { ...request.headers, host: `127.0.0.1:${listenPort}` },
  }, async (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    await pipeline(upstreamResponse, response);
  });
  upstream.once('error', (error) => { response.writeHead(502); response.end(error.message); });
  await pipeline(request, upstream);
});
server.listen(listenPort, '127.0.0.1', () => process.stdout.write('REQUEST_PROXY_READY\n'));
