#!/usr/bin/env node
// Real loopback OpenSSH + mutual TLS transports. Uses only a uniquely named fixture
// project and temporary database. Does not add nodes to the production instance.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createServer as httpsServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import net from 'node:net';
const dir = mkdtempSync(path.join(tmpdir(), 'composeops-remote-acceptance-'));
process.env.DB_PATH = path.join(dir, 'state.db');
process.env.DISABLE_BACKGROUND_JOBS = '1';
const cli = (bin, args) => execFileSync(bin, args, { cwd: dir, encoding: 'utf8', timeout: 120000, stdio: ['pipe','pipe','pipe'] }).trim();
const projectName = 'co-remote-' + Date.now(), composeFile = path.join(dir, 'compose.yml');
const compose = (...args) => cli('docker', ['compose','-p',projectName,'-f',composeFile,...args]);
const checks = []; let sshd, tlsServer;
const reserve = async () => { const server = net.createServer(); await new Promise(r => server.listen(0,'127.0.0.1',r)); const port=server.address().port; await new Promise(r=>server.close(r)); return port; };
const { upsertHost, getHost, deleteHost, pingHost, listHosts } = await import('../backend/src/services/docker-hosts.js');
const { sshReadFile, sshWriteFile, sshExec } = await import('../backend/src/services/remote-shell.js');
const { scanProjects, invalidateScanCache } = await import('../backend/src/services/scanner.js');
const { setProjectPreference } = await import('../backend/src/lib/db.js');
try {
  writeFileSync(composeFile, 'services:\n  app:\n    image: alpine:3.20\n    command: [sleep, "600"]\n', { mode: 0o600 });
  compose('up','-d','--pull','never');
  for (const key of ['host','client']) cli('ssh-keygen',['-q','-t','ed25519','-N','','-f',path.join(dir,key)]);
  const port=await reserve();
  writeFileSync(path.join(dir,'sshd.conf'), `ListenAddress 127.0.0.1\nPort ${port}\nHostKey ${dir}/host\nPidFile ${dir}/sshd.pid\nAuthorizedKeysFile ${dir}/client.pub\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nAllowUsers ${userInfo().username}\nSubsystem sftp internal-sftp\nLogLevel ERROR\n`);
  sshd=spawn('/usr/sbin/sshd',['-D','-e','-f',path.join(dir,'sshd.conf')],{stdio:['ignore','ignore','pipe']});
  let startup='';sshd.stderr.on('data',chunk=>{startup+=chunk;});
  await new Promise(r=>setTimeout(r,300));assert.equal(sshd.exitCode,null,startup);
  const fingerprint=cli('ssh-keygen',['-lf',path.join(dir,'host.pub'),'-E','sha256']).split(/\s+/)[1];
  const ssh = upsertHost({ id: projectName+'-ssh', name:'SSH acceptance',type:'ssh',host:'127.0.0.1',port,username:userInfo().username,privateKey:readFileSync(path.join(dir,'client'),'utf8'),hostFingerprint:fingerprint });
  const host=getHost(ssh.id);
  const probe=await pingHost(host.id);assert.equal(probe.ok,true,probe.message);assert.equal(getHost(host.id).status,'online');
  checks.push('OpenSSH pinned host key and Docker dial-stdio ping/version/container list');
  const file=path.join(dir,'remote.env');await sshWriteFile(host,file,'ACCEPTANCE_MARKER=initial\n');
  assert.equal((await sshReadFile(host,file)).content,'ACCEPTANCE_MARKER=initial\n');
  await sshWriteFile(host,file,'ACCEPTANCE_MARKER=updated\n');assert.equal((await sshReadFile(host,file)).content,'ACCEPTANCE_MARKER=updated\n');
  const result=await sshExec(host,['docker','compose','-p',projectName,'-f',composeFile,'ps','--format','json']);assert.equal(result.code,0);
  let project=(await scanProjects(host.id,{background:true})).find(row=>row.projectName===projectName);assert(project);
  setProjectPreference(project.id,{managed:true,mountEnabled:true});invalidateScanCache();
  project=(await scanProjects(host.id,{background:true})).find(row=>row.projectName===projectName);
  assert.equal(project.mountState,'remote_ssh');assert.equal(project.editable,true);
  checks.push('remote SFTP read/write and Compose execution, scoped discovery and editable workspace');
  const wrong=await pingHost('_probe',{...host,hostFingerprint:'SHA256:'+Buffer.alloc(32,7).toString('base64').replace(/=+$/,'')});assert.equal(wrong.ok,false);
  assert.equal(getHost(host.id).status,'online','temporary failed probe must not modify saved node');
  checks.push('changed SSH host key refused without modifying saved connection');

  cli('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.pem','-days','1','-subj','/CN=ComposeOps fixture CA']);
  for(const role of ['server','client-tls']) {
    cli('openssl',['req','-newkey','rsa:2048','-nodes','-keyout',role+'.key','-out',role+'.csr','-subj','/CN='+role]);
    writeFileSync(path.join(dir,role+'.ext'), role==='server'?'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n':'extendedKeyUsage=clientAuth\n');
    cli('openssl',['x509','-req','-in',role+'.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out',role+'.pem','-days','1','-extfile',role+'.ext']);
  }
  tlsServer=httpsServer({key:readFileSync(path.join(dir,'server.key')),cert:readFileSync(path.join(dir,'server.pem')),ca:readFileSync(path.join(dir,'ca.pem')),requestCert:true,rejectUnauthorized:true},(req,res)=>{
    const upstream=httpRequest({socketPath:'/var/run/docker.sock',method:req.method,path:req.url,headers:req.headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
    upstream.on('error',()=>{res.statusCode=502;res.end();});req.pipe(upstream);res.on('close',()=>upstream.destroy());
  });
  await new Promise(r=>tlsServer.listen(0,'127.0.0.1',r));
  const tls={ca:readFileSync(path.join(dir,'ca.pem'),'utf8'),cert:readFileSync(path.join(dir,'client-tls.pem'),'utf8'),key:readFileSync(path.join(dir,'client-tls.key'),'utf8')};
  const tcp=upsertHost({id:projectName+'-tls',name:'TLS acceptance',type:'tcp',host:'127.0.0.1',port:tlsServer.address().port,tls});
  assert.equal((await pingHost(tcp.id)).ok,true);
  const masked=listHosts().find(row=>row.id===tcp.id);assert.ok(!JSON.stringify(masked).includes('PRIVATE KEY'));
  const denied=await pingHost('_probe',{...getHost(tcp.id),tls:{ca:tls.ca}});assert.equal(denied.ok,false);
  const remote=(await scanProjects(tcp.id,{background:true})).find(row=>row.projectName===projectName);assert(remote);assert.equal(remote.mountState,'remote_api_only');assert.equal(remote.editable,false);
  checks.push('mutual TLS Docker API and credential masking; missing client identity rejected; API-only project stays read-only');
  console.log(JSON.stringify({passed:true,scope:'real loopback SSH and mutual TLS; isolated DB and fixture Compose project',checks},null,2));
} finally {
  for(const id of [projectName+'-ssh',projectName+'-tls']) if(getHost(id))deleteHost(id);
  if(tlsServer){tlsServer.closeAllConnections();await new Promise(r=>tlsServer.close(r));}
  if(sshd && sshd.exitCode===null){sshd.kill('SIGTERM');await new Promise(r=>sshd.once('exit',r));}
  try{compose('down','-v','--remove-orphans');}finally{rmSync(dir,{recursive:true,force:true});}
}
