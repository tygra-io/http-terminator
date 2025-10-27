import type { Server as HttpServer } from 'http';
import type { Http2SecureServer, Http2Server } from 'http2';
import type { Server as HttpsServer } from 'https';
import type { Duplex } from 'stream';

/**
 * Logger interface for logging messages during HTTP server termination.
 *
 * @property log Logs general informational messages.
 * @property warn Logs warning messages.
 * @property error Logs error messages.
 */
export type Logger = {
  readonly error: (...args: unknown[]) => void;
  readonly log: (...args: unknown[]) => void;
  readonly warn: (...args: unknown[]) => void;
};

/**
 * @property gracefulTerminationTimeout Number of milliseconds to allow for the active sockets to complete serving the response (default: 5000).
 * @property logger Logger instance for logging edge cases (default: console).
 * @property server Instance of http.Server.
 */
export type HttpTerminatorConfigurationInput = {
  readonly gracefulTerminationTimeout?: number;
  readonly logger?: Logger;
  readonly server: Http2SecureServer | Http2Server | HttpServer | HttpsServer;
};

/**
 * @property terminate Terminates HTTP server.
 */
export type HttpTerminator = {
  readonly terminate: () => Promise<void>;
};

export type InternalHttpTerminator = HttpTerminator & {
  readonly secureSockets: Set<Duplex>;
  readonly sockets: Set<Duplex>;
};
