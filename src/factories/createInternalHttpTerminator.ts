import http from 'http';
import type { Duplex } from 'stream';
import type {
  HttpTerminatorConfigurationInput,
  InternalHttpTerminator,
} from '../types';
import { waitFor } from '../utils';

const configurationDefaults = {
  gracefulTerminationTimeout: 5_000,
  logger: console,
};

export const createInternalHttpTerminator = (
  configurationInput: HttpTerminatorConfigurationInput,
): InternalHttpTerminator => {
  const configuration = {
    ...configurationDefaults,
    ...configurationInput,
  };

  const server = configuration.server;
  const logger = configuration.logger ?? configurationDefaults.logger;

  const sockets = new Set<Duplex>();
  const secureSockets = new Set<Duplex>();

  let isTerminating = false;
  let terminating: Promise<void> | undefined;

  server.on('connection', (socket: Duplex) => {
    if (isTerminating) {
      socket.destroy();
    } else {
      sockets.add(socket);

      socket.once('close', () => {
        sockets.delete(socket);
      });
    }
  });

  server.on('secureConnection', (socket: Duplex) => {
    if (isTerminating) {
      socket.destroy();
    } else {
      secureSockets.add(socket);

      socket.once('close', () => {
        secureSockets.delete(socket);
      });
    }
  });

  /**
   * Evaluate whether additional steps are required to destroy the socket.
   *
   * @see https://github.com/nodejs/node/blob/57bd715d527aba8dae56b975056961b0e429e91e/lib/_http_client.js#L363-L413
   */
  const destroySocket = (socket: Duplex) => {
    socket.destroy();

    if (sockets.has(socket)) {
      sockets.delete(socket);
    } else {
      secureSockets.delete(socket);
    }
  };

  const terminate = async (): Promise<void> => {
    try {
      if (isTerminating) {
        logger.warn(
          '[http-terminator] terminate() called while termination is already in progress',
        );
        await terminating;
        return;
      }

      isTerminating = true;

      let resolveTerminating: () => void;

      terminating = new Promise((resolve) => {
        resolveTerminating = resolve;
      });

      server.on('request', (_incomingMessage, outgoingMessage) => {
        if (!outgoingMessage.headersSent) {
          outgoingMessage.setHeader('connection', 'close');
        }
      });

      for (const socket of sockets) {
        // This is the HTTP CONNECT request socket.
        // @ts-expect-error Unclear if I am using wrong type or how else this should be handled.
        if (!(socket.server instanceof http.Server)) {
          continue;
        }

        // @ts-expect-error Unclear if I am using wrong type or how else this should be handled.
        const serverResponse = socket._httpMessage;

        if (serverResponse) {
          if (!serverResponse.headersSent) {
            serverResponse.setHeader('connection', 'close');
          }

          continue;
        }

        destroySocket(socket);
      }

      for (const socket of secureSockets) {
        // @ts-expect-error Unclear if I am using wrong type or how else this should be handled.
        const serverResponse = socket._httpMessage;

        if (serverResponse) {
          if (!serverResponse.headersSent) {
            serverResponse.setHeader('connection', 'close');
          }

          continue;
        }

        destroySocket(socket);
      }

      // Wait for all in-flight connections to drain, forcefully terminating any
      // open connections after the given timeout
      try {
        await waitFor(
          () => {
            return sockets.size === 0 && secureSockets.size === 0;
          },
          {
            interval: 10,
            timeout: configuration.gracefulTerminationTimeout,
          },
        );
      } catch {
        logger.warn(
          `[http-terminator] Graceful termination timeout expired (${configuration.gracefulTerminationTimeout}ms). Forcefully destroying remaining sockets.`,
        );
      } finally {
        for (const socket of sockets) {
          destroySocket(socket);
        }

        for (const socket of secureSockets) {
          destroySocket(socket);
        }
      }

      server.close((error) => {
        if (error) {
          logger.error(
            '[http-terminator] Error occurred during server close:',
            error,
          );
          resolveTerminating();
        } else {
          logger.log('[http-terminator] Server closed successfully');
          resolveTerminating();
        }
      });

      await terminating;
    } catch (error) {
      logger.error(
        '[http-terminator] Unexpected error occurred during termination:',
        error,
      );
    }
  };

  return {
    secureSockets,
    sockets,
    terminate,
  };
};
