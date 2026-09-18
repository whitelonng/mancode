// Local acceptance probe. Uses synthetic identities against the existing ticket fixture only.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdir,readFile,realpath,writeFile,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import {build} from 'esbuild';
import {Entry} from '@napi-rs/keyring';
const base=process.argv[2];
if(!base||!path.isAbsolute(base))throw new Error('Pass the authorized absolute test directory');
await mkdir(base,{recursive:true});
const root=process.cwd(),project=path.join(base,'project'),home=path.join(base,'home'),pkg=path.join(base,'ticket-executor');
for(const dir of [project,home,pkg])await mkdir(dir,{recursive:true,mode:0o700});
const cli=path.join(root,'dist/cli.js');
const node=await realpath(process.execPath);
const initialized=spawnSync(node,[cli,'init','--empty','--yes','--platform','codex'],{cwd:project,encoding:'utf8',env:process.env});
assert.equal(initialized.status,0,initialized.stderr);
const source=path.join(root,'.mancode/local/drafts/secrets-spike-api.mjs');
await build({stdin:{contents:`export {Vault,vaultContext} from './src/secrets/vault.ts';export {prepareAction,installAction,parseAction} from './src/secrets/actions.ts';`,resolveDir:root},outfile:source,bundle:true,platform:'node',format:'esm',packages:'external'});
const {Vault,vaultContext,prepareAction,installAction,parseAction}=await import(source);
const fixture=await import('/Users/whitelonng/code/mancode测试/fixture/src/app.mjs');
let requests=0,authorized=0;
const app=fixture.createApp({logger:{error(){}}});
const server=createServer((req,res)=>{requests++;if(req.headers.authorization==='Bearer fixture-a')authorized++;return app(req,res);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
const code=`let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',async()=>{try{const {credentials,fixed}=JSON.parse(s);const r=await fetch(fixed.url,{headers:{Authorization:'Bearer '+credentials.auth},redirect:'error'});if(r.status!==200)process.exitCode=1;else{const data=await r.json();if(!Array.isArray(data.tickets))process.exitCode=1;}}catch{process.exitCode=1;}});`;
await writeFile(path.join(pkg,'main.cjs'),code);
let context;
let testKeyRemoved=false;
context=await vaultContext(project);
const spec=parseAction({schemaVersion:1,name:'ticket-check',version:'1',executable:node,packagePath:pkg,entry:'main.cjs',fields:{},credentials:{auth:'ticket-auth'},fixed:{url:`http://127.0.0.1:${port}/tickets`},target:'Local synthetic Ticket API fixture',effects:'Read synthetic tenant tickets; no production action',output:'status-only',timeoutMs:60000,outputBytes:4096});
const evidence={node:process.version,platform:process.platform,backend:'@napi-rs/keyring@2.1.0',hosts:[],business:{fixture:'Ticket API fixture',review:'fixed loopback target, redirect:error, no raw logs or downstream argv/env, GET only'}};
const runHost=(bin,args)=>new Promise(resolve=>{const child=spawn(bin,args,{cwd:project,env:process.env,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);const timer=setTimeout(()=>child.kill('SIGTERM'),120000);child.on('error',()=>{clearTimeout(timer);resolve({exit:null,output:'host unavailable'});});child.on('close',exit=>{clearTimeout(timer);resolve({exit,output:out,diagnostic:err});});});
try {
 await Vault.transaction(context,true,v=>v.set('ticket-auth','api-key','Synthetic fixture authentication','fixture-a'));
 await Vault.transaction(context,false,async v=>installAction(v,await prepareAction(v,spec)));
 await writeFile(path.join(project,'request.json'),'{}');
 const command=`'${node}' '${cli}' secret run ticket-check --input request.json --json`;
 const direct=await runHost('/bin/sh',['-c',command]);evidence.direct={exit:direct.exit,receipt:JSON.parse(direct.output)};
 assert.equal(direct.exit,0,JSON.stringify(evidence.direct));assert.equal(evidence.direct.receipt.status,'executor_succeeded');
 if(process.argv.includes('--hosts')){
  const prompt=`Integration acceptance only. Run exactly this one shell command once in the current directory: ${command}. Do not read other files, inspect secret storage, change configuration or retry. Report only the returned status. This uses synthetic data and a localhost fixture.`;
  const reviewed=process.argv.includes('--codex-reviewed');
  const codexPrompt=reviewed?`${prompt} The prior isolated test was rejected before execution because the sandbox cannot access the system Keychain. For this new test, request require_escalated approval for the exact command once through the automatic approval reviewer. Do not change sandbox settings or credentials.`:prompt;
  evidence.codexApproval=reviewed?'automatic review for exact synthetic test command':'default sandbox';
  for(const [host,args]of [['codex',['exec',...(reviewed?['--approve-for-me']:['--sandbox','workspace-write']),'--skip-git-repo-check','--json','-C',project,codexPrompt]],['claude',['-p','--no-session-persistence','--tools','Bash','--allowedTools',`Bash(${command})`,'--output-format','json',prompt]]]){
   const before=requests;const result=await runHost(host,args);await writeFile(path.join(base,`${host}.jsonl`),JSON.stringify(result));evidence.hosts.push({host,exit:result.exit,requests:requests-before,executed:requests>before,reportedSuccess:result.output.includes('executor_succeeded')});
  }
 }
 evidence.requests=requests;evidence.authorized=authorized;
 // S20: same-user access is deliberately not claimed to be isolated.
 const vault=JSON.parse(await readFile(path.join(context.directory,'vault.json'),'utf8'));const key=new Entry('mancode.secrets.v1',vault.keyId).getSecret();evidence.sameUserKeyAccessBoundary=key!==null;if(key)key.fill(0);
 // Actual missing-Keychain-key failure: no fallback and no additional business request.
 new Entry('mancode.secrets.v1',vault.keyId).deleteCredential();testKeyRemoved=true;
 const beforeMissing=requests;const missing=await runHost('/bin/sh',['-c',command]);
 const rejected=JSON.parse(missing.output);assert.equal(missing.exit,5);assert.equal(rejected.code,'KEYSTORE_UNAVAILABLE');assert.equal(requests,beforeMissing);
 evidence.missingKey={exit:missing.exit,code:rejected.code,additionalRequests:requests-beforeMissing};
 await writeFile(path.join(base,'evidence.json'),JSON.stringify(evidence,null,2));
 console.log(JSON.stringify(evidence));
 if(process.argv.includes('--hosts'))assert(evidence.hosts.length===2&&evidence.hosts.every(h=>h.executed&&h.reportedSuccess&&h.requests===1),'Both hosts must perform exactly one successful fixture request');
} finally {
 try{const vault=JSON.parse(await readFile(path.join(context.directory,'vault.json'),'utf8'));if(!testKeyRemoved)new Entry('mancode.secrets.v1',vault.keyId).deleteCredential();await rm(context.directory,{recursive:true,force:true});}finally{await new Promise(resolve=>server.close(resolve));}
}
