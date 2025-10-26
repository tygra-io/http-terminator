import { createServer } from 'http';
import { promisify } from 'util';
import type { TestServerFactory } from './types';

export const createHttpServer: TestServerFactory = (requestHandler) => {
  const server = createServer((incomingMessage, serverResponse) => {
    requestHandler(serverResponse);
  });

  let serverShutingDown;

  const stop = () => {
    if (serverShutingDown) {
      return serverShutingDown;
    }

    serverShutingDown = promisify(server.close.bind(server))();

    return serverShutingDown;
  };

  const getConnections = () => {
    return promisify(server.getConnections.bind(server))();
  };

  return new Promise((resolve, reject) => {
    server.once('error', reject);

    server.listen(() => {
      // @ts-expect-error-error address should be always available inside the `.listen()` block.
      const port = server.address().port;
      const url = 'http://localhost:' + port;

      resolve({
        getConnections,
        port,
        server,
        stop,
        url,
      });
    });
  });
};
