#!/usr/bin/env -S node -r esm

import 'localenv';
import optimist from 'optimist';

import log from 'book';
import Debug from 'debug';

import CreateServer from '../server.js';

const debug = Debug('localtunnel');

const argv = optimist
    .usage('Usage: $0 --port [num]')
    .options('secure', {
        default: false,
        describe: 'use this flag to indicate proxy over https'
    })
    .options('port', {
        default: '80',
        describe: 'listen on this port for outside requests'
    })
    .options('address', {
        default: '0.0.0.0',
        describe: 'IP address to bind to'
    })
    .options('domain', {
        describe:
            'Specify the base domain name. This is optional if hosting localtunnel from a regular example.com domain. This is required if hosting a localtunnel server from a subdomain (i.e. lt.example.com where clients will be client-app.lt.example.com)'
    })
    .options('landing', {
        describe:
            "Specify the landing page url where users will be redirected to when browsing to the server's domain. This is optional."
    })
    .options('max-sockets', {
        default: 10,
        describe:
            'maximum number of tcp sockets each client is allowed to establish at one time (the tunnels)'
    })
    .options('grace-timeout', {
        default: 60000,
        describe:
            'milliseconds to wait for a client to (re)connect before destroying the tunnel (default: 60000)'
    }).argv;

if (argv.help) {
    optimist.showHelp();
    process.exit();
}

const server = CreateServer({
    max_tcp_sockets: argv['max-sockets'],
    secure: argv.secure,
    domain: argv.domain,
    landing: argv.landing,
    grace_timeout: argv['grace-timeout'],
});

server.listen(argv.port, argv.address, () => {
    debug('server listening on port: %d', server.address().port);
});

let shuttingDown = false;

function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    debug('received %s, starting graceful shutdown...', signal);

    // Stop accepting new tunnel registrations
    server.close(() => {
        debug('HTTP server closed');
        process.exit(0);
    });

    // Force exit after 30s
    setTimeout(() => {
        log.error('forced shutdown after timeout');
        process.exit(1);
    }, 30000).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
    log.error(err);
});

process.on('unhandledRejection', (reason, promise) => {
    log.error(reason);
});

// vim: ft=javascript
