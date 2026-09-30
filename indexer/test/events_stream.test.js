import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/api.js';
import { eventEmitter } from '../src/events.js';

describe('GET /api/events/stream', () => {
  let server;
  let baseUrl;
  let clients;

  beforeEach(async () => {
    clients = [];
    server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    for (const { request } of clients) {
      request.destroy();
    }
    if (server) {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  function connect() {
    return new Promise((resolve, reject) => {
      const request = http.get(`${baseUrl}/api/events/stream`, (response) => {
        const client = { request, response };
        clients.push(client);
        resolve(client);
      });
      request.once('error', reject);
    });
  }

  function nextChunk(response) {
    return new Promise((resolve) => {
      response.once('data', (chunk) => resolve(chunk.toString()));
    });
  }

  async function waitForListenerCount(expected) {
    const deadline = Date.now() + 1000;
    while (
      eventEmitter.listenerCount('event') !== expected &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(eventEmitter.listenerCount('event'), expected);
  }

  it('streams emitted events to connected clients and cleans up on disconnect', async () => {
    const initialListenerCount = eventEmitter.listenerCount('event');
    const firstClient = await connect();
    const secondClient = await connect();

    for (const { response } of [firstClient, secondClient]) {
      assert.equal(response.headers['content-type'], 'text/event-stream');
      assert.equal(response.headers['x-accel-buffering'], 'no');
    }
    assert.equal(eventEmitter.listenerCount('event'), initialListenerCount + 2);

    const firstEvent = { seq: 1, function: 'transfer' };
    const firstClientEvent = nextChunk(firstClient.response);
    const secondClientEvent = nextChunk(secondClient.response);
    eventEmitter.emit('event', firstEvent);
    assert.equal(
      await firstClientEvent,
      `data: ${JSON.stringify(firstEvent)}\n\n`,
    );
    assert.equal(
      await secondClientEvent,
      `data: ${JSON.stringify(firstEvent)}\n\n`,
    );

    const firstClientClosed = new Promise((resolve) =>
      firstClient.response.once('close', resolve),
    );
    firstClient.request.destroy();
    await firstClientClosed;
    await waitForListenerCount(initialListenerCount + 1);

    const secondEvent = { seq: 2, function: 'approve' };
    const secondClientNextEvent = nextChunk(secondClient.response);
    eventEmitter.emit('event', secondEvent);
    assert.equal(
      await secondClientNextEvent,
      `data: ${JSON.stringify(secondEvent)}\n\n`,
    );

    const secondClientClosed = new Promise((resolve) =>
      secondClient.response.once('close', resolve),
    );
    secondClient.request.destroy();
    await secondClientClosed;
    await waitForListenerCount(initialListenerCount);
  });
});
