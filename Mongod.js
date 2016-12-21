'use strict';

/**
 * Configuration options for a {@link Mongod}.
 * @typedef {Object} Mongod~Config
 * @property {String} [bin=mongod]
 * @property {String} [config]
 * @property {(Number|String)} [port=27017]
 * @property {(String)} [dbpath]
 */

/**
 * Invoked when an operation (i.e. {@link Mongod#open}) completes.
 * @callback Mongod~callback
 * @argument {Error} err
 */

const childprocess = require('child_process');
const events = require('events');
const keyRE = /(pid=\d+)|(port=\d+)|(waiting\s+for\s+connections)|(already\s+in\s+use)|(denied\s+for\s+socket)|((error|exception|badvalue)(.|\n)*)/ig;
const errorRE = /^error|exception|badvalue/i;
const whiteSpaceRE = / /ig;
const newlineRE = /\r?\n/;

/**
 * Start and stop a local MongoDB server like a boss.
 * @class
 */
class Mongod extends events.EventEmitter {

  /**
   * Get a function that takes chunks of stdin data, aggregates it, and passes
   * it in complete lines, one by one, to a given {@link Mongod~callback}.
   * @argument {Mongod~callback} callback
   * @return {Function}
   */
  static getTextLineAggregator(callback) {
    let buffer = '';

    return (data) => {
      const fragments = data.toString().split(newlineRE);
      const lines = fragments.slice(0, fragments.length - 1);

      // If there was an unended line in the previous dump, complete it by
      // the first section.
      lines[0] = buffer + lines[0];

      // If there is an unended line in this dump, store it to be completed by
      // the next. This assumes there will be a terminating newline character
      // at some point. Generally, this is a safe assumption.
      buffer = fragments[fragments.length - 1];

      for (let line of lines) {
        callback(line);
      }
    };
  }

  /**
   * Populate a given {@link Mongod~Config} with values from a
   * given {@link Mongod~Config}.
   * @protected
   * @argument {Mongod~Config} source
   * @argument {Mongod~Config} target
   * @return {Mongod~Config}
   */
  static parseConfig(source, target) {
    if (target == null) {
      target = Object.create(null);
    }

    if (source == null) {
      return target;
    }

    if (source.bin != null) {
      target.bin = source.bin;
    }

    if (source.conf != null) {
      target.conf = source.conf;

      return target;
    }

    if (source.dbpath != null) {
      target.dbpath = source.dbpath;
    }

    if (source.port != null) {
      target.port = source.port;
    }

    return target;
  }

  /**
   * Parse process flags for MongoDB from a given {@link Mongod~Config}.
   * @protected
   * @argument {Mongod~Config} config
   * @return {Array.<String>}
   */
  static parseFlags(config) {
    if (config.conf != null) {
      return ['--config', config.conf];
    }

    const flags = [];

    if (config.dbpath != null) {
      flags.push('--dbpath', config.dbpath);
    }

    if (config.port != null) {
      flags.push('--port', config.port);
    }

    return flags;
  }

  /**
   * Start a given {@link Mongod}.
   * @protected
   * @argument {Mongod} server
   * @argument {Boolean} isCallback
   * @return {Promise}
   */
  static open(server, isCallback) {
    if (server.isClosing) {
      server.openPromise = new Promise((resolve, reject) => {
        const open = () =>
          Mongod.open(server, true).then(resolve).catch(reject);

        server.isClosing = false;
        server.isOpening = true;

        server.closePromise.then(open).catch(open);
      });

      return server.openPromise;
    }

    if (server.isOpening && !isCallback || server.isRunning) {
      return server.openPromise;
    }

    server.openPromise = new Promise((resolve, reject) => {
      const matchHandler = (match) => {
        let err = null;
        let k, v;

        if (errorRE.test(match)) {
          k = 'error';
          v = match.trim();
        }
        else {
          const t = match.split('=');

          k = t[0].replace(whiteSpaceRE, '').toLowerCase();
          v = t[1];
        }

        switch (k) {
          case 'error':
            err = new Error(v);
            err.code = -1;

            break;

          case 'alreadyinuse':
            err = new Error('Address already in use');
            err.code = -2;

            break;

          case 'deniedforsocket':
            err = new Error('Permission denied');
            err.code = -3;

            break;

          case 'pid':
          case 'port':
            server[k] = Number(v);

            return false;

          case 'waitingforconnections':
            server.isRunning = true;

            server.emit('open');

            break;

          default:
            return false;
        }

        server.isOpening = false;

        if (err === null) {
          resolve(null);
        }
        else {
          reject(err);
        }

        return true;
      };

      const dataHandler = Mongod.getTextLineAggregator((value) => {
        const matches = value.match(keyRE);

        if (matches !== null) {
          for (let match of matches) {
            if (matchHandler(match, value)) {
              server.process.stdout.removeListener('data', dataHandler);
              server.process.stderr.removeListener('data', dataHandler);

              return;
            }
          }
        }
      });

      const exitHandler = () => {
        server.close();
      };

      const getDataPropagator = (event) =>
        Mongod.getTextLineAggregator((line) => server.emit(event, line));

      server.isOpening = true;

      server.emit('opening');

      server.process = childprocess.spawn(
        server.config.bin,
        Mongod.parseFlags(server.config)
      );

      server.process.stderr.on('data', dataHandler);
      server.process.stderr.on('data', getDataPropagator('stderr'));
      server.process.stdout.on('data', dataHandler);
      server.process.stdout.on('data', getDataPropagator('stdout'));
      server.process.on('close', () => {
        server.process = null;
        server.port = null;
        server.pid = null;
        server.isRunning = false;
        server.isClosing = false;

        process.removeListener('exit', exitHandler);
        server.emit('close');
      });
      process.on('exit', exitHandler);
    });

    return server.openPromise;
  }

  /**
   * Stop a given {@link Mongod}.
   * @protected
   * @argument {Mongod} server
   * @argument {Boolean} isCallback
   * @return {Promise}
   */
  static close(server, isCallback) {
    if (server.isOpening) {
      server.closePromise = new Promise((resolve, reject) => {
        const close = () =>
          exports.close(server, true).then(resolve).catch(reject);

        server.isOpening = false;
        server.isClosing = true;

        server.openPromise.then(close).catch(close);
      });

      return server.closePromise;
    }

    if (server.isClosing && !isCallback || !server.isRunning) {
      return server.closePromise;
    }

    server.closePromise = new Promise((resolve) => {
      server.isClosing = true;

      server.emit('closing');
      server.process.once('close', () => resolve(null));
      server.process.kill();
    });

    return server.closePromise;
  }

  /**
   * Construct a new {@link Mongod}.
   * @argument {(Number|String|Mongod~Config)} [configOrPort]
   * A number or string that is a port or an object for configuration.
   */
  constructor(configOrPort) {
    super();

    /**
     * Configuration options.
     * @protected
     * @type {Mongod~Config}
     */
    this.config = {
      bin: 'mongod',
      conf: null,
      port: 27017,
      dbpath: null,
    };

    /**
     * The current {@link Mongod#process} identifier.
     * @protected
     * @type {Number}
     */
    this.pid = null;

    /**
     * The port the MongoDB server is currently bound to.
     * @protected
     * @type {Number}
     */
    this.port = null;

    /**
     * The current process.
     * @protected
     * @type {ChildProcess}
     */
    this.process = null;

    /**
     * The last {@link Promise} returned by {@link Mongod#open}.
     * @protected
     * @type {Promise}
     */
    this.openPromise = Promise.resolve(null);

    /**
     * The last {@link Promise} returned by {@link Mongod#close}.
     * @protected
     * @type {Promise}
     */
    this.closePromise = Promise.resolve(null);

    /**
     * Determine if the instance is closing a MongoDB server; {@linkcode true}
     * while a process is being, or about to be, killed until the
     * contained MongoDB server either closes or errs.
     * @readonly
     * @type {Boolean}
     */
    this.isClosing = false;

    /**
     * Determine if the instance is starting a MongoDB server; {@linkcode true}
     * while a process is spawning, or about tobe spawned, until the
     * contained MongoDB server either starts or errs.
     * @readonly
     * @type {Boolean}
     */
    this.isRunning = false;

    /**
     * Determine if the instance is running a MongoDB server; {@linkcode true}
     * once a process has spawned and the contained MongoDB server is ready
     * to service requests.
     * @readonly
     * @type {Boolean}
     */
    this.isOpening = false;

    // Parse the given {@link Mongod~Config}.
    if (typeof configOrPort === 'number' || typeof configOrPort === 'string') {
      this.config.port = configOrPort;
    }
    else if (typeof configOrPort === 'object') {
      Mongod.parseConfig(configOrPort, this.config);
    }
  }

  /**
   * Open the server.
   * @argument {Mongod~callback} [callback]
   * @return {Promise}
   */
  open(callback) {
    const promise = Mongod.open(this, false);

    if (typeof callback === 'function') {
      promise.then(callback).catch(callback);
    }

    return promise;
  }

  /**
   * Close the server.
   * @argument {Mongod~callback} [callback]
   * @return {Promise}
   */
  close(callback) {
    const promise = Mongod.close(this, false);

    if (typeof callback === 'function') {
      promise.then(callback).catch(callback);
    }

    return promise;
  }
}

module.exports = exports = Mongod;