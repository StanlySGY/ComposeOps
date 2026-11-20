import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import './helpers/isolated-db.js';
import { upsertHost, deleteHost, setActiveHost } from '../src/services/docker-hosts.js';
import { getContainerResourceStats, getCostAnalysisReport, recordCostSnapshot, getCostTrends, getStorageStats } from '../src/services/cost-analysis.js';

async function fixture(t, name, delayMs = 0) {
  const calls = { stats: 0, active: 0, max: 0 }; let hold;
  const containers = Array.from({ length: 8 }, (_, i) => ({ Id: name + i, Names: ['/' + name + i], State: 'running', Created: 1, Labels: { 'com.docker.compose.project': name } }));
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.includes('/stats')) {
      calls.stats++; calls.active++; calls.max = Math.max(calls.max, calls.active);
      return setTimeout(() => { calls.active--; res.end(JSON.stringify({ cpu_stats: {cpu_usage:{total_usage:200},system_cpu_usage:2000,online_cpus:1},precpu_stats:{cpu_usage:{total_usage:100},system_cpu_usage:1000},memory_stats:{usage:1024*1024,limit:4*1024*1024} })); }, delayMs);
    }
    if (req.url.includes('/containers/json')) { const send=()=>res.end(JSON.stringify(containers)); if(hold)hold(send);else send();return; }
    res.end(JSON.stringify(req.url.includes('/images/json') ? [] : { Images: [], Containers: [], Volumes: [], BuildCache: [] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const host=upsertHost({name,type:'tcp',host:'127.0.0.1',port:server.address().port});
  t.after(async()=>{setActiveHost('local');deleteHost(host.id);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return {host,calls,hold:cb=>{hold=cb;}};
}

test('cost collection shares simultaneous requests and bounds parallel container sampling', async t=>{
 const a=await fixture(t,'cost-parallel',30);setActiveHost(a.host.id);
 const [first,second]=await Promise.all([getContainerResourceStats(),getContainerResourceStats()]);
 assert.deepEqual(first,second);assert.equal(first.length,8);assert.equal(a.calls.stats,8,'a cold concurrent request must not scan twice');
 assert.ok(a.calls.max>1&&a.calls.max<=6,'sampling uses bounded concurrency');assert.equal(first[0].cpuPercent,10);
});

test('cost report retains one host across awaits and trends never cross nodes',async t=>{
 const a=await fixture(t,'cost-node-a'),b=await fixture(t,'cost-node-b');
 const releases=[];let began;const started=new Promise(r=>{began=r;});
 a.hold(send=>{releases.push(send);began();});setActiveHost(a.host.id);
 const pending=getCostAnalysisReport();await started;setActiveHost(b.host.id);a.hold(null);releases.forEach(send=>send());
 const report=await pending;assert.ok(report.projects.every(p=>p.projectName==='cost-node-a'));assert.ok(report.containers.every(c=>c.projectName==='cost-node-a'));
 setActiveHost(a.host.id);await recordCostSnapshot();assert.equal(getCostTrends().length,1);
 setActiveHost(b.host.id);assert.deepEqual(getCostTrends(),[]);
});


test('cost storage excludes referenced unique image layers from reclaimable space', async t => {
  const { default: docker } = await import('../src/services/docker.js');
  const original = docker.df; t.after(() => { docker.df = original; });
  const mb = 1024 * 1024;
  docker.df = async () => ({ LayersSize: 10 * mb, Images: [
    { Containers: 1, Size: 8 * mb, SharedSize: 2 * mb },
    { Containers: 0, Size: 4 * mb, SharedSize: 2 * mb },
  ] });
  const result = await getStorageStats('local');
  assert.equal(result.images.sizeMB, 10);
  assert.equal(result.images.reclaimableMB, 4);
});
