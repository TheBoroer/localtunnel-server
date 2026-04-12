import http from 'http';
import Debug from 'debug';
import pump from 'pump';
import EventEmitter from 'events';

const debug = Debug('lt:Client');

// A client encapsulates req/res handling using an agent
//
// If an agent is destroyed, the request handling will error
// The caller is responsible for handling a failed request
class Client extends EventEmitter {
    constructor(options) {
        super();

        const agent = (this.agent = options.agent);
        const id = (this.id = options.id);

        // how long to wait for a client to (re)connect before destroying the tunnel
        const graceMs = options.graceTimeout || 60000;

        // client is given a grace period in which they can connect before they are _removed_
        this.graceTimeout = setTimeout(() => {
            this.close();
        }, graceMs).unref();

        agent.on('online', () => {
            debug('[%s] client online', id);
            clearTimeout(this.graceTimeout);
        });

        agent.on('offline', () => {
            debug('[%s] client offline', id);

            // if there was a previous timeout set, we don't want to double trigger
            clearTimeout(this.graceTimeout);

            // client is given a grace period in which they can re-connect before they are _removed_
            debug('[%s] starting %ds grace period', id, graceMs / 1000);
            this.graceTimeout = setTimeout(() => {
                this.close();
            }, graceMs).unref();
        });

        // TODO(roman): an agent error removes the client, the user needs to re-connect?
        // how does a user realize they need to re-connect vs some random client being assigned same port?
        agent.once('error', (err) => {
            this.close();
        });
    }

    getAgentIps() {
        return this.agent.agentIps;
    }

    stats() {
        return this.agent.stats();
    }

    close() {
        clearTimeout(this.graceTimeout);
        this.agent.destroy();
        this.emit('close');
    }

    handleRequest(req, res) {
        debug('[%s] > %s', this.id, req.url);

        // Reject early if the tunnel is overloaded to avoid queuing
        // requests that will likely time out anyway
        const pendingCount = this.agent.waitingCreateConn?.length ?? 0;
        if (pendingCount >= 10) {
            debug('[%s] tunnel overloaded (%d pending), rejecting', this.id, pendingCount);
            res.writeHead(429, { 'Content-Type': 'text/plain' });
            res.end('Tunnel is busy, try again later');
            return;
        }

        const opt = {
            path: req.url,
            agent: this.agent,
            method: req.method,
            headers: req.headers,
        };

        const clientReq = http.request(opt, (clientRes) => {
            debug('[%s] < %s', this.id, req.url);

            // Inject Custom Headers Here

            // restrict bot/spiders/search engines
            clientRes.headers['X-Robots-Tag'] =
                'noindex, nofollow, noarchive, nosnippet, nositelinksearchbox, noimageindex';

            // expose the real source ip
            const clientIps = this.getAgentIps();
            if (clientIps && clientIps.length > 0) {
                clientRes.headers['X-Localtunnel-Agent-Ips'] = JSON.stringify(
                    this.getAgentIps(),
                );
            }

            // write response code and headers
            // Tunnel clients may send headers with invalid characters
            // (e.g. non-ASCII in content-disposition). Filter them out
            // rather than crashing the response.
            try {
                res.writeHead(clientRes.statusCode, clientRes.headers);
            } catch {
                debug('[%s] sanitizing invalid headers from tunnel client', this.id);
                for (const [key, value] of Object.entries(clientRes.headers)) {
                    try {
                        res.setHeader(key, value);
                    } catch {
                        // skip headers with invalid characters
                    }
                }
                res.writeHead(clientRes.statusCode);
            }

            // using pump is deliberate - see the pump docs for why
            pump(clientRes, res);
        });

        // this can happen when underlying agent produces an error
        // in our case we 502 gateway error this?
        // if we have already sent headers?
        clientReq.once('error', (err) => {
            debug('[%s] request error: %s', this.id, err.message);
            if (res && !res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'text/plain' });
                res.end('Bad Gateway');
            } else if (res) {
                res.end();
            }
        });

        // using pump is deliberate - see the pump docs for why
        pump(req, clientReq);
    }

    handleUpgrade(req, socket) {
        debug('[%s] > [up] %s', this.id, req.url);
        socket.once('error', (err) => {
            // These client side errors can happen if the client dies while we are reading
            // We don't need to surface these in our logs.
            if (err.code == 'ECONNRESET' || err.code == 'ETIMEDOUT') {
                return;
            }
            console.error(err);
        });

        this.agent.createConnection({}, (err, conn) => {
            debug('[%s] < [up] %s', this.id, req.url);
            // any errors getting a connection mean we cannot service this request
            if (err) {
                socket.end();
                return;
            }

            // socket met have disconnected while we waiting for a socket
            if (!socket.readable || !socket.writable) {
                conn.destroy();
                socket.end();
                return;
            }

            // websocket requests are special in that we simply re-create the header info
            // then directly pipe the socket data
            // avoids having to rebuild the request and handle upgrades via the http client
            const arr = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
            for (let i = 0; i < req.rawHeaders.length - 1; i += 2) {
                arr.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
            }

            arr.push('');
            arr.push('');

            // using pump is deliberate - see the pump docs for why
            pump(conn, socket);
            pump(socket, conn);
            conn.write(arr.join('\r\n'));
        });
    }
}

export default Client;
