import './helpers/isolated-db.js';
import assert from 'node:assert/strict';
import https from 'node:https';
import test from 'node:test';

const SERVER_CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUclLC6OraNL6okTYsj7hE9TUXH4gwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MTAxNDA1NTMzOVoXDTM2MTAx
MTA1NTMzOVowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAymcsEpsDGNqDsZSZQ5SbGp3lhcqccjYe2s4FXAu/j7ih
6RlTcwc5TQF8zqc+WO/QmV+hAFt7Hg/ix6LjEwjjzJIW4erSq3VGRH6hAlLKrBSt
saS7zWjDoKfEtOEsgNDkXBvtYf96LU8CYA+FJJlWQ9kKlwqX3BZpNdY2Vtve0J5e
P3Sl29R4Hu7bOWzuVR/aWLRRs8Pifd0kdOapR/722LZYn/Fa0yuQuc+aCrc4BxoP
Zk3JsH5V/TkMESjRMyP0cK0L7Of9U6KMFcHw28OUYK09kPKaRas8OAZ1y2MMku8Q
NXNV1pm+FnGh90ay1fMlCkhvND5n6PIi5m++juP2HQIDAQABo28wbTAdBgNVHQ4E
FgQUcbovhlZUD3wrwC3mFVrjHh+tGoMwHwYDVR0jBBgwFoAUcbovhlZUD3wrwC3m
FVrjHh+tGoMwGgYDVR0RBBMwEYcEfwAAAYIJbG9jYWxob3N0MA8GA1UdEwEB/wQF
MAMBAf8wDQYJKoZIhvcNAQELBQADggEBAAvdfMxfp5eOFYtMuXm7IYyOGpVMglWS
kQxibHoSYobnPvoMsqLov2PWLzqoXj23XUNnV9bPraOGBI5w3Q36b8kyytVnx8ll
/Cjudk9u9HmIhDC/5BJ8iA6vzY8Yx6QHWt0G9pdb1uJTU58QVqYWYTcT2Wd5D17b
d6HDvMTn2hxY67cg/wI7Vd//kT5HCmKwwseIoS40qwERzB3d/r9/Z8y4CuhM3161
Htr9aoiYoGKKn4MxuUQRXDncBmGb+zG3TFxt+MuZKhU3aGmADvzFcCJphKdqtsWE
h/kQgI+be0AYgffVM0Iqm8kunF3xQbM2kHAWpwDQfgwdviCPQAVIdUg=
-----END CERTIFICATE-----`;
const SERVER_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDKZywSmwMY2oOx
lJlDlJsaneWFypxyNh7azgVcC7+PuKHpGVNzBzlNAXzOpz5Y79CZX6EAW3seD+LH
ouMTCOPMkhbh6tKrdUZEfqECUsqsFK2xpLvNaMOgp8S04SyA0ORcG+1h/3otTwJg
D4UkmVZD2QqXCpfcFmk11jZW297Qnl4/dKXb1Hge7ts5bO5VH9pYtFGzw+J93SR0
5qlH/vbYtlif8VrTK5C5z5oKtzgHGg9mTcmwflX9OQwRKNEzI/RwrQvs5/1ToowV
wfDbw5RgrT2Q8ppFqzw4BnXLYwyS7xA1c1XWmb4WcaH3RrLV8yUKSG80Pmfo8iLm
b76O4/YdAgMBAAECgf94/e+FUeBuev5PmFpKaaTW952Jy/JTIKC3khsqnh+HSpvl
gEbAHojVmTi1pXdkCDvmHgiPeuzzenqFU/Np/pmluQQn96azk9ZCxl6bhPNvczFQ
s0Kh1KC2goKUJo98cadENUt2dCh7ZLcgYASVKRSB8e/RntBK6xq1T9hOAu5IxkGd
7i0di93PwXddLUMEqJvFK88S33JeXgOdoAUTJJEdn74XvoTN6LE1Jq3OD6+urQJo
iZ1Vx7ZQWCdkZzf/nlV4Dt/6r52gJWJ2cVZI/kRmT+B91SLBLxNjMlUMa6SgkipN
8O5OGp/lAcHzbIxEq0QpnagjQszVDZ+aRDP8MQ8CgYEA5EkqOiJFNm9fQBJyEgbJ
SjCNlqA/+3hq2JPkPQtKZLFOScNRaAn8CLqZrWubmPD827FS9wcSeANb3Gf3nOQb
DnTQr/4WIgETGbnYwRk3T7BV3c3CbDa2zkOOaQPONA/+Nq4z0PXarEXktstoQZKS
0hBNqpvu6iIkJ2DIRjfQRHcCgYEA4vmaVpIK9yXLI/Uc8YDvanhCM0c8jKymr2Kz
SzoJF1NOT3YL08HVplvsybuXJbuQwM84dNyB7N/XKYWTqRHp89VmIKblt1ZN90eD
JNcEdTaJp3crc0eTTGD4i/OLb6f/o5ev3+ocllyR9h2RqUKtxksyqgTK0+ImYer9
RvYBYwsCgYART+Md6X9qM2P7zepMp6sYLzptk9WGUol3xy9l2bdYj4GqYl+IDknI
t63z0tdH7+6dEoOCLE0gQND0lAXZJgtPO1igIBq5lW9HYiqn6iuhpXO9kF8QKc4P
MlxYZmt600OqDefsDtj4e4xuuFo9rsnnmEjriUvDAbfQLKzDdnQa3QKBgQCDvo2v
IiXrPqyiumuKYmSVUChcy0SCAtTdiFS5nX4ZY+lYhhRnXWM9pK3UimY5KJ3kzGLg
sf1YGLUzDK2gvR0mwv78hONhf17R4Vhl0chsoLNV2P4Hc8wz0TVzRnHw5Xqk4i7b
sW/WdvTh/lfF/0YOiydlOFLimandvCA3SCOV8QKBgQDO88qu0t2KQZOfGWkkBv5Z
soayo9Y09XzHuiIvL27f6sFX5QpWyx4Y0+E0IptqhY8jT1iT0aM0E9c7cmZZhtfI
q9dDIrMPyWQ3DzQwQfExGNtOiwpae5yy1Vt2Elj2lJyRaMFuxwFR6VeNeapxbKOM
H3eimnNtCLE7ZMQaPCD6aQ==
-----END PRIVATE KEY-----`;
const WRONG_CA = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUduVTOc4o1EpXMFg/ahuvVzbcCM8wDQYJKoZIhvcNAQEL
BQAwIzEhMB8GA1UEAwwYd3JvbmctY29tcG9zZW9wcy10ZXN0LWNhMB4XDTI2MTAx
NDA1NTM1MFoXDTM2MTAxMTA1NTM1MFowIzEhMB8GA1UEAwwYd3JvbmctY29tcG9z
ZW9wcy10ZXN0LWNhMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqZIt
tTHFQrt+C+NEBryXcXWVLZxWBn7eEaJX8W5QVnbo2dLvlCZ4/2ZsqqGEYGAXw0/a
w6VNsTKzyOfXcZGlmt3jVuMiPw2vbeYUQbAJqNWIlJXNfzg31WJaors1jp2aqH/j
T1NjVWAVTVpddVuGcs1Eb2Cd13DrujBsRWjiuK+RRkaOjxmh0QUJ71qhYzQIFuE8
vWSVy1HO+PfqxBRlipNv4z/w0Z2K/eC/TG/y/zutrA/MSH1jMZdBxUpab4tikUOU
TkPlHIOIgvP7alGCeMNOi0Gl2i0GH4fgeGuKUK8MQGXseddxcsnkHVVHusH8gV7d
RQs6pnogoQvAN2SVoQIDAQABo1MwUTAdBgNVHQ4EFgQUxjW1pr5pdiPy2mdc5MT/
BDz1cKQwHwYDVR0jBBgwFoAUxjW1pr5pdiPy2mdc5MT/BDz1cKQwDwYDVR0TAQH/
BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEABK/szbF+h+JMOBzOlce5n3LpX4/U
0RdeHnLHWOyj6R2FqgiVg+VTbu58AhU6nOQ4kKCTqhLYGvembPJxETzcqq6iQKM8
KDA4/Wab8QVJpQvaaLZC/h98Kcg3dJfiuFYkByOdecJCJas7gnB47opYYBSQEbzi
+5p3KoRsyzJypBocHey2EyelbgzCT/fGa8T0aJmotcGVfg8QAx3et7AFSHgSnZFv
sbAHk8MGcLykwels5xjNMzbN5y1eCAVxxoZyOYastErXmf6DMoxZp+v7d5RergfL
u18tpsPl3geKm6MZYdABRDexqVZY2KBdP/s58xrbUuEcJP71JFzpEmTl9g==
-----END CERTIFICATE-----`;

test('TLS Docker API: one node certificate failure does not poison a second healthy node', async (t) => {
  const createFixture = async () => {
    const server = https.createServer({
      key: SERVER_KEY,
      cert: SERVER_CERT,
      ca: SERVER_CERT,
      requestCert: true,
      rejectUnauthorized: true,
    }, (request, response) => {
      if (request.url !== '/_ping') {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain' }).end('OK');
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }));
    return { server, port: server.address().port };
  };

  const [nodeA, nodeB] = await Promise.all([createFixture(), createFixture()]);
  const { createDockerClient } = await import('../src/services/docker-hosts.js');
  const client = (node, ca, cert = SERVER_CERT, key = SERVER_KEY) => createDockerClient({
    id: `tls-${node.port}`,
    type: 'tcp',
    host: '127.0.0.1',
    port: node.port,
    tls: { ca, cert, key },
  });

  await client(nodeA, SERVER_CERT).ping();
  await client(nodeB, SERVER_CERT).ping();
  await assert.rejects(client(nodeA, WRONG_CA).ping(), /certificate|self-signed|issuer|unable to verify/i);
  // A's failure must not contaminate the client cache or trust configuration for B.
  await client(nodeB, SERVER_CERT).ping();
  nodeA.server.closeAllConnections();
  await new Promise((resolve) => nodeA.server.close(resolve));
  await assert.rejects(client(nodeA, SERVER_CERT).ping());
  await client(nodeB, SERVER_CERT).ping();
});

test('TLS Docker API: validates CA, supports client certificates and rejects bad trust', async (t) => {
  const server = https.createServer({ key: SERVER_KEY, cert: SERVER_CERT, ca: SERVER_CERT, requestCert: true, rejectUnauthorized: true }, (request, response) => {
    if (request.url !== '/_ping') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain' }).end('OK');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));

  const base = { id: 'tls-fixture', type: 'tcp', host: '127.0.0.1', port: server.address().port };
  const { createDockerClient } = await import('../src/services/docker-hosts.js');
  await createDockerClient({ ...base, tls: { ca: SERVER_CERT, cert: SERVER_CERT, key: SERVER_KEY } }).ping();
  await assert.rejects(
    createDockerClient({ ...base, tls: { ca: SERVER_CERT, cert: '', key: '' } }).ping(),
  );
  await assert.rejects(
    createDockerClient({ ...base, tls: { ca: WRONG_CA, cert: SERVER_CERT, key: SERVER_KEY } }).ping(),
    /certificate|self-signed|issuer|unable to verify/i,
  );
});
