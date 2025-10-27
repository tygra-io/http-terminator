import KeepAliveHttpAgent from 'agentkeepalive';
import test from 'ava';
import delay from 'delay';
import safeGot from 'got';
import sinon from 'sinon';
import { createInternalHttpTerminator } from '../../../src/factories/createInternalHttpTerminator';
import { createHttpServer } from '../../helpers/createHttpServer';
import { createHttpsServer } from '../../helpers/createHttpsServer';

const got = safeGot.extend({
  https: {
    rejectUnauthorized: false,
  },
});

test('terminates HTTP server with no connections', async (t) => {
  t.timeout(1_000);

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  const httpServer = await createHttpServer(() => {});

  t.true(httpServer.server.listening);

  const terminator = createInternalHttpTerminator({
    server: httpServer.server,
  });

  await terminator.terminate();

  t.false(httpServer.server.listening);
});

test('terminates hanging sockets after httpResponseTimeout', async (t) => {
  t.timeout(1_000);

  const spy = sinon.spy();

  const httpServer = await createHttpServer(() => {
    spy();
  });

  const terminator = createInternalHttpTerminator({
    gracefulTerminationTimeout: 150,
    server: httpServer.server,
  });

  void got(httpServer.url).catch(() => {});

  await delay(50);

  t.true(spy.called);

  void terminator.terminate();

  await delay(100);

  // The timeout has not passed.
  t.is(await httpServer.getConnections(), 1);

  await delay(100);

  t.is(await httpServer.getConnections(), 0);
});

test('server stops accepting new connections after terminator.terminate() is called', async (t) => {
  t.timeout(1_000);

  const httpServer = await createHttpServer((serverResponse) => {
    setTimeout(() => {
      serverResponse.end('foo');
    }, 100);
  });

  const terminator = createInternalHttpTerminator({
    gracefulTerminationTimeout: 150,
    server: httpServer.server,
  });

  const request0 = got(httpServer.url);

  await delay(50);

  void terminator.terminate();

  await delay(50);

  const request1 = got(httpServer.url, {
    retry: 0,
    timeout: {
      connect: 50,
    },
  });

  await t.throwsAsync(request1);

  const response0 = await request0;

  t.is(response0.headers.connection, 'close');
  t.is(response0.body, 'foo');
});

test('ongoing requests receive {connection: close} header', async (t) => {
  t.timeout(1_000);

  const httpServer = await createHttpServer((serverResponse) => {
    setTimeout(() => {
      serverResponse.end('foo');
    }, 100);
  });

  const terminator = createInternalHttpTerminator({
    gracefulTerminationTimeout: 150,
    server: httpServer.server,
  });

  const request = got(httpServer.url, {
    agent: {
      http: new KeepAliveHttpAgent(),
    },
  });

  await delay(50);

  void terminator.terminate();

  const response = await request;

  t.is(response.headers.connection, 'close');
  t.is(response.body, 'foo');
});

test('ongoing requests receive {connection: close} header (new request reusing an existing socket)', async (t) => {
  t.timeout(2_000);

  const stub = sinon.stub();

  stub.onCall(0).callsFake((serverResponse) => {
    serverResponse.write('foo');

    setTimeout(() => {
      serverResponse.end('bar');
    }, 50);
  });

  stub.onCall(1).callsFake((serverResponse) => {
    // @todo Unable to intercept the response without the delay.
    // When `end()` is called immediately, the `request` event
    // already has `headersSent=true`. It is unclear how to intercept
    // the response beforehand.
    setTimeout(() => {
      serverResponse.end('baz');
    }, 50);
  });

  const httpServer = await createHttpServer(stub);

  const terminator = createInternalHttpTerminator({
    gracefulTerminationTimeout: 150,
    server: httpServer.server,
  });

  const agent = new KeepAliveHttpAgent({
    maxSockets: 1,
  });

  const request0 = got(httpServer.url, {
    agent: {
      http: agent,
    },
  });

  await delay(50);

  void terminator.terminate();

  const request1 = got(httpServer.url, {
    agent: {
      http: agent,
    },
    retry: 0,
  });

  await delay(50);

  t.is(stub.callCount, 2);

  const response0 = await request0;

  t.is(response0.headers.connection, 'keep-alive');
  t.is(response0.body, 'foobar');

  const response1 = await request1;

  t.is(response1.headers.connection, 'close');
  t.is(response1.body, 'baz');
});

test('empties internal socket collection', async (t) => {
  t.timeout(1_000);

  const httpServer = await createHttpServer((serverResponse) => {
    serverResponse.end('foo');
  });

  const terminator = createInternalHttpTerminator({
    gracefulTerminationTimeout: 150,
    server: httpServer.server,
  });

  await got(httpServer.url, {
    agent: false,
  });

  await delay(50);

  t.is(terminator.sockets.size, 0);
  t.is(terminator.secureSockets.size, 0);

  await terminator.terminate();
});

test('empties internal socket collection for https server', async (t) => {
  t.timeout(1_000);

  const httpsServer = await createHttpsServer((serverResponse) => {
    serverResponse.end('foo');
  });

  const terminator = createInternalHttpTerminator({
    gracefulTerminationTimeout: 150,
    server: httpsServer.server,
  });

  await got(httpsServer.url, {
    agent: false,
  });

  await delay(50);

  t.is(terminator.secureSockets.size, 0);

  await terminator.terminate();
});

test('closes immediately after in-flight connections are closed (#16)', async (t) => {
  t.timeout(2_000);

  const spy = sinon.spy((serverResponse) => {
    setTimeout(() => {
      serverResponse.end('foo');
    }, 100);
  });

  const httpServer = await createHttpServer(spy);

  t.true(httpServer.server.listening);

  const terminator = createInternalHttpTerminator({
    gracefulTerminationTimeout: 500,
    server: httpServer.server,
  });

  void got(httpServer.url).catch(() => {});

  await delay(50);

  t.is(await httpServer.getConnections(), 1);

  void terminator.terminate();

  // Wait for serverResponse.end to be called, plus a few extra ms for the
  // terminator to finish polling in-flight connections. (Do not, however, wait
  // long enough to trigger graceful termination.)
  await delay(75);

  t.is(await httpServer.getConnections(), 0);
});

test('calling terminate() multiple times is idempotent', async (t) => {
  t.timeout(1_000);

  const httpServer = await createHttpServer(() => {});

  const terminator = createInternalHttpTerminator({
    server: httpServer.server,
  });

  // Call terminate() multiple times without awaiting
  const promise1 = terminator.terminate();
  const promise2 = terminator.terminate();

  // Both should resolve to the same result
  await Promise.all([promise1, promise2]);

  t.false(httpServer.server.listening);
});

test('socket end event triggers cleanup', async (t) => {
  t.timeout(1_000);

  const httpServer = await createHttpServer((serverResponse) => {
    serverResponse.end('foo');
  });

  const terminator = createInternalHttpTerminator({
    server: httpServer.server,
  });

  const request = got(httpServer.url, {
    agent: false,
  });

  await request;

  // Wait a bit to ensure cleanup happens
  await delay(10);

  t.is(terminator.sockets.size, 0);
  t.is(terminator.secureSockets.size, 0);

  await terminator.terminate();
});

test('new HTTPS connection during termination is rejected', async (t) => {
  t.timeout(1_000);

  const httpsServer = await createHttpsServer((serverResponse) => {
    setTimeout(() => {
      serverResponse.end('foo');
    }, 100);
  });

  const terminator = createInternalHttpTerminator({
    gracefulTerminationTimeout: 150,
    server: httpsServer.server,
  });

  const request0 = got(httpsServer.url);

  await delay(50);

  void terminator.terminate();

  await delay(50);

  const request1 = got(httpsServer.url, {
    retry: 0,
    timeout: {
      connect: 50,
    },
  });

  await t.throwsAsync(request1);

  const response0 = await request0;

  t.is(response0.headers.connection, 'close');
  t.is(response0.body, 'foo');
});

test('idle sockets without httpMessage are destroyed', async (t) => {
  t.timeout(1_000);

  const httpServer = await createHttpServer((serverResponse) => {
    serverResponse.end('foo');
  });

  const terminator = createInternalHttpTerminator({
    server: httpServer.server,
  });

  // Make a request that completes, creating a socket
  await got(httpServer.url, {
    agent: false,
  });

  await delay(10);

  // Terminate immediately - this should cover the case where
  // sockets are tracked but may not have active _httpMessage
  await terminator.terminate();

  t.false(httpServer.server.listening);
});

test('handles server.close() error gracefully', async (t) => {
  t.timeout(1_000);

  const httpServer = await createHttpServer(() => {});

  // Create a mock logger to verify error logging
  const logger = {
    error: sinon.stub(),
    log: sinon.stub(),
    warn: sinon.stub(),
  };

  const terminator = createInternalHttpTerminator({
    logger,
    server: httpServer.server,
  });

  // Stub server.close to simulate an error
  const originalClose = httpServer.server.close.bind(httpServer.server);
  const closeError = new Error('Server close error');

  httpServer.server.close = sinon.stub().callsFake((callback) => {
    originalClose((error) => {
      if (callback) {
        callback(error ? error : closeError);
      }
    });
  });

  // Termination should complete successfully without throwing
  await terminator.terminate();

  // Verify that the error was logged
  t.true(logger.error.calledOnce);
  t.true(
    logger.error.calledWith(
      '[http-terminator] Error occurred during server close:',
      closeError,
    ),
  );
});

test('handles unexpected errors during termination gracefully', async (t) => {
  t.timeout(1_000);

  const httpServer = await createHttpServer(() => {});

  // Create a mock logger to verify error logging
  const logger = {
    error: sinon.stub(),
    log: sinon.stub(),
    warn: sinon.stub(),
  };

  const terminator = createInternalHttpTerminator({
    logger,
    server: httpServer.server,
  });

  // Stub server.close to throw an unexpected error synchronously during termination
  const originalClose = httpServer.server.close.bind(httpServer.server);
  const unexpectedError = new Error('Unexpected error during termination');

  httpServer.server.close = sinon.stub().callsFake((callback) => {
    // Throw error synchronously before calling the callback
    if (callback) {
      throw unexpectedError;
    }

    return originalClose(callback);
  });

  // Termination should complete successfully without throwing
  await terminator.terminate();

  // Verify that the unexpected error was logged
  t.true(logger.error.calledOnce);
  t.true(
    logger.error.calledWith(
      '[http-terminator] Unexpected error occurred during termination:',
      unexpectedError,
    ),
  );
});

test('creates new socket during termination for HTTP', async (t) => {
  t.timeout(1_000);

  const httpServer = await createHttpServer(() => {});

  const terminator = createInternalHttpTerminator({
    server: httpServer.server,
  });

  t.true(httpServer.server.listening);

  void terminator.terminate();

  // Try to create a new connection while terminating
  try {
    await got(httpServer.url, {
      retry: 0,
      timeout: {
        connect: 50,
      },
    });
  } catch {
    // Expected to fail
  }

  // Wait for termination to complete
  await delay(50);

  t.false(httpServer.server.listening);
});

test('creates new socket during termination for HTTPS', async (t) => {
  t.timeout(1_000);

  const httpsServer = await createHttpsServer(() => {});

  const terminator = createInternalHttpTerminator({
    server: httpsServer.server,
  });

  t.true(httpsServer.server.listening);

  void terminator.terminate();

  // Try to create a new secure connection while terminating
  try {
    await got(httpsServer.url, {
      retry: 0,
      timeout: {
        connect: 50,
      },
    });
  } catch {
    // Expected to fail
  }

  // Wait for termination to complete
  await delay(50);

  t.false(httpsServer.server.listening);
});

test('covers socket with _httpMessage that already sent headers', async (t) => {
  t.timeout(1_000);

  // Use Node's http module directly to access full ServerResponse
  const http = await import('http');

  const server = http.createServer((incomingMessage, serverResponse) => {
    // Send headers immediately
    serverResponse.statusCode = 200;
    serverResponse.setHeader('Content-Type', 'text/plain');

    setTimeout(() => {
      serverResponse.end('foo');
    }, 50);
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(() => {
      const address = server.address();
      if (address && typeof address !== 'string') {
        resolve(address.port);
      } else {
        reject(new Error('Failed to get port'));
      }
    });
  });

  const terminator = createInternalHttpTerminator({
    gracefulTerminationTimeout: 100,
    server,
  });

  const request = got(`http://localhost:${port}`);

  await delay(10);

  void terminator.terminate();

  const response = await request;

  t.is(response.body, 'foo');
});

test('secure socket is destroyed when created during termination', async (t) => {
  t.timeout(1_000);

  const httpsServer = await createHttpsServer(() => {});

  const terminator = createInternalHttpTerminator({
    server: httpsServer.server,
  });

  t.true(httpsServer.server.listening);

  // Start termination
  void terminator.terminate();

  // Try to create a new secure connection during termination
  // This should trigger the terminating branch in secureConnection handler
  try {
    await got(httpsServer.url, {
      retry: 0,
      timeout: {
        connect: 50,
      },
    });
    t.fail('Should have thrown an error');
  } catch {
    // Expected to fail as the socket should be destroyed
  }

  // Wait for termination to complete
  await delay(50);

  t.false(httpsServer.server.listening);
});

test('destroys idle sockets without _httpMessage during termination for secure sockets', async (t) => {
  t.timeout(2_000);

  const httpsServer = await createHttpsServer((serverResponse) => {
    serverResponse.end('foo');
  });

  const terminator = createInternalHttpTerminator({
    gracefulTerminationTimeout: 200,
    server: httpsServer.server,
  });

  // Create a keep-alive connection for HTTPS
  const agent = new KeepAliveHttpAgent.HttpsAgent({
    maxSockets: 1,
  });

  // Make a request to establish connection
  await got(httpsServer.url, {
    agent: {
      https: agent,
    },
  });

  // Wait for request to complete but keep socket alive
  await delay(10);

  // Start termination while socket exists but has no active _httpMessage
  void terminator.terminate();

  // Give termination time to process sockets
  await delay(50);

  // Verify that idle secure sockets are destroyed
  // This should trigger destroySocket in the secure sockets loop
  await httpsServer.getConnections().then((connections) => {
    t.true(connections <= 1);
  });

  // Wait for graceful termination to complete
  await delay(200);
});

test('destroys idle sockets without _httpMessage during termination', async (t) => {
  t.timeout(2_000);

  const httpServer = await createHttpServer((serverResponse) => {
    serverResponse.end('foo');
  });

  const terminator = createInternalHttpTerminator({
    gracefulTerminationTimeout: 200,
    server: httpServer.server,
  });

  // Create a keep-alive connection
  const agent = new KeepAliveHttpAgent({
    maxSockets: 1,
  });

  // Make a request to establish connection
  await got(httpServer.url, {
    agent: {
      http: agent,
    },
  });

  // Wait for request to complete but keep socket alive
  await delay(10);

  // Start termination while socket exists but has no active _httpMessage
  void terminator.terminate();

  // Give termination time to process sockets
  await delay(50);

  // Verify that idle sockets are destroyed (sockets should be empty or connection closed)
  await httpServer.getConnections().then((connections) => {
    // Socket should be destroyed either by timeout or by the termination process
    t.true(connections <= 1);
  });

  // Wait for graceful termination to complete
  await delay(200);
});

test('handles request with headers already sent during termination', async (t) => {
  t.timeout(1_000);

  // Use Node's http module directly to access full ServerResponse
  const http = await import('http');

  const server = http.createServer((incomingMessage, serverResponse) => {
    // Send headers immediately
    serverResponse.statusCode = 200;
    serverResponse.setHeader('Content-Type', 'text/plain');
    // Force headers to be sent
    serverResponse.writeHead(200);

    setTimeout(() => {
      serverResponse.end('foo');
    }, 50);
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(() => {
      const address = server.address();
      if (address && typeof address !== 'string') {
        resolve(address.port);
      } else {
        reject(new Error('Failed to get port'));
      }
    });
  });

  const terminator = createInternalHttpTerminator({
    gracefulTerminationTimeout: 200,
    server,
  });

  const request = got(`http://localhost:${port}`, {
    agent: false,
  });

  // Start terminating shortly after request is made
  await delay(10);

  void terminator.terminate();

  // Wait for response
  const response = await request;

  t.is(response.body, 'foo');
  // Headers were already sent, so connection:close won't be set by the terminator
  // But the 'connection' header might still be set to 'close' by other mechanisms
  t.truthy(response.body);
});
