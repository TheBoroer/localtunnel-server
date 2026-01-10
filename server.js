import log from 'book';
import Koa from 'koa';
import tldjs from 'tldjs';
import Debug from 'debug';
import http from 'http';
import { hri } from 'human-readable-ids';
import { humanId } from 'human-id';
import Router from 'koa-router';

import ClientManager from './lib/ClientManager.js';

const debug = Debug('localtunnel:server');

const getEndpointIps = (request) => {
    // request.headers['x-forwarded-for'] could be a comma separated list of IPs (if client is behind proxies)
    // TODO: change this to use request-ip package or something better to prevent x-forwarded-for spoofing?
    return request.headers['x-forwarded-for'] || request.ip;
};

export default function (opt) {
    opt = opt || {};

    const validHosts = opt.domain ? [opt.domain] : undefined;
    const myTldjs = tldjs.fromUserSettings({ validHosts });
    const landingPage = opt.landing || 'https://localtunnel.github.io/www/';

    function GetClientIdFromHostname(hostname) {
        try {
            // from pull request: https://github.com/localtunnel/server/pull/118
            const hostnameAndPort = hostname.split(':');
            return myTldjs.getSubdomain(hostnameAndPort[0]);
        } catch (error) {
            console.error(
                'Error getting client id from hostname:',
                hostname,
                'error:',
                error,
            );

            return null;
        }
    }

    const manager = new ClientManager(opt);

    const schema = opt.secure ? 'https' : 'http';

    const app = new Koa();
    const router = new Router();

    router.get('/api/status', async (ctx, next) => {
        const stats = manager.stats;
        ctx.body = {
            tunnels: stats.tunnels,
            mem: process.memoryUsage(),
        };
    });

    router.get('/api/tunnels/:id/status', async (ctx, next) => {
        const clientId = ctx.params.id;
        const client = manager.getClient(clientId);
        if (!client) {
            ctx.throw(404);
            return;
        }

        const stats = client.stats();
        ctx.body = {
            connected_sockets: stats.connectedSockets,
        };
    });

    app.use(router.routes());
    app.use(router.allowedMethods());

    // root endpoint
    app.use(async (ctx, next) => {
        const path = ctx.request.path;
        const endpointIp = getEndpointIps(ctx.request);

        // skip anything not on the root path
        if (path !== '/') {
            await next();
            return;
        }

        const isNewClientRequest = ctx.query['new'] !== undefined;
        if (isNewClientRequest) {
            // const reqId = hri.random();

            const randomId = humanId({
                separator: '-',
                capitalize: false,
            });
            // const reqId = `${randomId}-${endpointIp.replace(/\./g, '-')}`;

            const reqId = `${randomId}`;

            debug(`new client request on '/' for id: '${reqId}'`);
            const info = await manager.newClient(reqId, ctx);

            const url =
                schema + '://' + info.id + '.' + (opt.domain || ctx.request.host);
            info.url = url;

            ctx.set('x-localtunnel-subdomain', info.id);
            ctx.set('x-localtunnel-endpoint', endpointIp);

            ctx.body = info;
            return;
        }

        // no new client request, send to landing page
        ctx.redirect(landingPage);
    });

    // anything after the / path is a request for a specific client name
    // This is a backwards compat feature
    app.use(async (ctx, next) => {
        const parts = ctx.request.path.split('/');
        const endpointIp = getEndpointIps(ctx.request);

        // any request with several layers of paths is not allowed
        // rejects /foo/bar
        // allow /foo
        if (parts.length !== 2) {
            await next();
            return;
        }

        const reqId = parts[1];

        // limit requested hostnames to 63 characters
        if (
            !/^(?:[a-z0-9][a-z0-9\-]{4,63}[a-z0-9]|[a-z0-9]{4,63})$/.test(reqId)
        ) {
            const msg =
                'Invalid subdomain. Subdomains must be lowercase and between 4 and 63 alphanumeric characters.';
            ctx.status = 403;
            ctx.body = {
                message: msg,
            };
            return;
        }

        debug(`new client request on '${ctx.path}' for id '${reqId}'`);
        const info = await manager.newClient(reqId, ctx);

        const url =
            schema + '://' + info.id + '.' + (opt.domain || ctx.request.host);
        info.url = url;

        ctx.set('x-localtunnel-subdomain', info.id);
        ctx.set('x-localtunnel-endpoint', endpointIp);

        ctx.body = info;
        return;
    });

    const server = http.createServer();

    const appCallback = app.callback();

    server.on('request', (req, res) => {
        // without a hostname, we won't know who the request is for
        const hostname = req.headers.host;
        if (!hostname) {
            res.statusCode = 400;
            res.end('Host header is required');
            return;
        }

        const clientId = GetClientIdFromHostname(hostname);
        if (!clientId) {
            appCallback(req, res);
            return;
        }

        const client = manager.getClient(clientId);
        if (!client) {
            // res.statusCode = 523;
            // res.end('523 -  Origin tunnel is unreachable');
            res.statusCode = 503;
            res.setHeader('X-Localtunnel-Status', 'Tunnel Unavailable');
            res.end('503 - Tunnel Unavailable');
            return;
        }

        client.handleRequest(req, res);
    });

    server.on('upgrade', (req, socket, head) => {
        const hostname = req.headers.host;
        if (!hostname) {
            socket.destroy();
            return;
        }

        const clientId = GetClientIdFromHostname(hostname);
        if (!clientId) {
            socket.destroy();
            return;
        }

        const client = manager.getClient(clientId);
        if (!client) {
            socket.destroy();
            return;
        }

        client.handleUpgrade(req, socket);
    });

    return server;
}
