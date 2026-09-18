// Build first. Creates and installs a local tarball; never publishes.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir,readFile,readdir,writeFile,access} from 'node:fs/promises';
import path from 'node:path';
const base=process.argv[2];assert(base&&path.isAbsolute(base));await mkdir(base,{recursive:true});
const run=(bin,args,options={})=>{const r=spawnSync(bin,args,{encoding:'utf8',...options});assert.equal(r.status,0,r.stderr);return r.stdout;};
const pack=JSON.parse(run('npm',['pack','--ignore-scripts','--json','--pack-destination',base]))[0];
assert(!pack.files.some(f=>f.path.includes('gateway/')));
for(const f of ['docs/privacy-rule-sources.md','docs/privacy-upstream-license.txt','docs/privacy-gateway-retirement.md','docs/secrets-guide.md','docs/secrets-security.md','dist/execution/worker.js'])assert(pack.files.some(x=>x.path===f),f);
const results=[];
for(const optional of [true,false]){
 const install=path.join(base,optional?'installed':'without-keyring');await mkdir(install,{recursive:true});
 run('npm',['install','--ignore-scripts','--no-audit','--no-fund',...(optional?[]:['--omit=optional']),'--prefix',install,path.join(base,pack.filename)]);
 const pkg=path.join(install,'node_modules/mancode'),cli=path.join(pkg,'dist/cli.js');
 for(const f of await readdir(path.join(pkg,'dist'))){if(!/\.(?:js|map|ts)$/.test(f))continue;assert(!/src\/gateway\/|src\/commands\/privacy-gateway|startGatewayServer|registerPrivacyGatewayCommands/.test(await readFile(path.join(pkg,'dist',f),'utf8')),f);}
 for(const args of [['privacy','gateway','run'],['init','--gateway-privacy'],['init','--no-gateway-privacy']]){const r=spawnSync(process.execPath,[cli,...args],{cwd:install,encoding:'utf8'});assert.notEqual(r.status,0);assert.match(r.stderr,/unknown/);}
 const project=path.join(install,'project');await mkdir(project,{recursive:true});
 run(process.execPath,[cli,'init','--empty','--yes','--platform','codex'],{cwd:project});
 const status=JSON.parse(run(process.execPath,[cli,'privacy','status','--json'],{cwd:project}));assert.equal(status.schemaVersion,2);assert.deepEqual(Object.keys(status).sort(),['schemaVersion','shared']);
 await writeFile(path.join(install,'sample.txt'),'ordinary synthetic text');
 run(process.execPath,[cli,'privacy','scan','--file','sample.txt','--json'],{cwd:install});
 run(process.execPath,[cli,'privacy','preview','--file','sample.txt','--output','preview.txt','--json'],{cwd:install});
 assert.equal(await readFile(path.join(install,'preview.txt'),'utf8'),'ordinary synthetic text');
 assert.match(run(process.execPath,[cli,'secret','--help'],{cwd:install}),/run/);
 if(!optional)await assert.rejects(access(path.join(install,'node_modules/@napi-rs/keyring')));
 results.push({optionalBackend:optional,ordinaryCLI:true,scanner:true,preview:true,statusV2:true,retiredCommandsRejected:true,bundleAndMaps:true});
}
const evidence={package:pack.filename,node:process.version,platform:process.platform,results};await writeFile(path.join(base,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
