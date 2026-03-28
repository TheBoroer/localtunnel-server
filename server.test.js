import request from 'supertest';
import assert from 'assert';
import ws from 'ws';
const { Server: WebSocketServer } = ws;
import WebSocket from 'ws';
import net from 'net';

import createServer from './server.js';

describe('Server', () => {
    it('server starts and stops', async () => {
        const server = createServer();
        await new Promise((resolve) => server.listen(resolve));
        await new Promise((resolve) => server.close(resolve));
    });

    it('should redirect root requests to landing page', async () => {
        const server = createServer();
        const res = await request(server).get('/');
        assert.equal(
            'https://localtunnel.github.io/www/',
            res.headers.location,
        );
    });

    it('should support custom base domains', async () => {
        const server = createServer({
            domain: 'domain.example.com',
        });

        const res = await request(server).get('/');
        assert.equal(
            'https://localtunnel.github.io/www/',
            res.headers.location,
        );
    });

    it('reject long domain name requests', async () => {
        const server = createServer();
        const res = await request(server).get(
            '/thisdomainisoutsidethesizeofwhatweallowwhichissixtythreecharacters',
        );
        assert.equal(
            res.body.message,
            'Invalid subdomain. Subdomains must be lowercase and between 4 and 63 alphanumeric characters.',
        );
    });

    it('should upgrade websocket requests', async () => {
        const hostname = 'websocket-test';
        const server = createServer({
            domain: 'example.com',
        });
        await new Promise((resolve) => server.listen(resolve));

        const res = await request(server).get('/websocket-test');
        const localTunnelPort = res.body.port;

        const wss = await new Promise((resolve) => {
            const wsServer = new WebSocketServer({ port: 0 }, () => {
                resolve(wsServer);
            });
        });

        const websocketServerPort = wss.address().port;

        const ltSocket = net.createConnection({ port: localTunnelPort });
        const wsSocket = net.createConnection({ port: websocketServerPort });
        ltSocket.pipe(wsSocket).pipe(ltSocket);

        wss.once('connection', (ws) => {
            ws.once('message', (message) => {
                ws.send(message);
            });
        });

        const ws = new WebSocket('http://localhost:' + server.address().port, {
            headers: {
                host: hostname + '.example.com',
            },
        });

        ws.on('open', () => {
            ws.send('something');
        });

        await new Promise((resolve) => {
            ws.once('message', (msg) => {
                assert.equal(msg, 'something');
                resolve();
            });
        });

        wss.close();
        await new Promise((resolve) => server.close(resolve));
    });

    it('should support the /api/tunnels/:id/status endpoint', async () => {
        const server = createServer();
        await new Promise((resolve) => server.listen(resolve));

        // no such tunnel yet
        const res = await request(server).get(
            '/api/tunnels/foobar-test/status',
        );
        assert.equal(res.statusCode, 404);

        // request a new client called foobar-test
        {
            const res = await request(server).get('/foobar-test');
        }

        {
            const res = await request(server).get(
                '/api/tunnels/foobar-test/status',
            );
            assert.equal(res.statusCode, 200);
            assert.deepEqual(res.body, {
                connected_sockets: 0,
            });
        }

        await new Promise((resolve) => server.close(resolve));
    });

    it('POST /api/tunnels/active should return only active tunnel IDs', async () => {
        const server = createServer();
        await new Promise((resolve) => server.listen(resolve));

        // create two tunnels
        await request(server).get('/active-test-one');
        await request(server).get('/active-test-two');

        // ask which of these are active (include a fake one)
        const res = await request(server)
            .post('/api/tunnels/active')
            .send(['active-test-one', 'active-test-two', 'does-not-exist']);

        assert.equal(res.statusCode, 200);
        assert.ok(Array.isArray(res.body));
        assert.ok(res.body.includes('active-test-one'));
        assert.ok(res.body.includes('active-test-two'));
        assert.ok(!res.body.includes('does-not-exist'));

        await new Promise((resolve) => server.close(resolve));
    });

    it('POST /api/tunnels/active should return empty array when none match', async () => {
        const server = createServer();
        await new Promise((resolve) => server.listen(resolve));

        const res = await request(server)
            .post('/api/tunnels/active')
            .send(['no-such-tunnel']);

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, []);

        await new Promise((resolve) => server.close(resolve));
    });

    it('POST /api/tunnels/active should reject non-array body', async () => {
        const server = createServer();
        await new Promise((resolve) => server.listen(resolve));

        const res = await request(server)
            .post('/api/tunnels/active')
            .send({ not: 'an array' });

        assert.equal(res.statusCode, 400);
        assert.equal(res.body.error, 'Expected JSON array of tunnel IDs');

        await new Promise((resolve) => server.close(resolve));
    });

    it('POST /api/tunnels/active should reject invalid JSON', async () => {
        const server = createServer();
        await new Promise((resolve) => server.listen(resolve));

        const res = await request(server)
            .post('/api/tunnels/active')
            .set('Content-Type', 'application/json')
            .send('not json at all');

        assert.equal(res.statusCode, 400);

        await new Promise((resolve) => server.close(resolve));
    });
});
