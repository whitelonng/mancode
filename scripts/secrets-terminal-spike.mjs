// Synthetic-only PTY acceptance. Never feed real credentials through this probe.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {build} from 'esbuild';
import {Entry} from '@napi-rs/keyring';
import {assertNoTerminalEcho} from './secrets-terminal-evidence.mjs';
const base=process.argv[2];
assert(base&&path.isAbsolute(base),'Pass an authorized absolute test directory');
await mkdir(base,{recursive:true});
const project=path.join(base,'project');await mkdir(project,{recursive:true});
const root=process.cwd(),cli=path.join(root,'dist/cli.js'),node=await realpath(process.execPath);
assert.equal(spawnSync(node,[cli,'init','--empty','--yes','--platform','codex'],{cwd:project,stdio:'pipe'}).status,0);
const source=path.join(root,'.mancode/local/drafts/secrets-terminal-api.mjs');
await build({stdin:{contents:`export {vaultContext,Vault} from './src/secrets/vault.ts';`,resolveDir:root},outfile:source,bundle:true,platform:'node',format:'esm',packages:'external'});
const {vaultContext,Vault}=await import(source);const context=await vaultContext(project);
const pkg=path.join(base,'executor');await mkdir(pkg,{recursive:true});
await writeFile(path.join(pkg,'main.cjs'),"let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{const x=JSON.parse(s);if(!x.credentials.token||!x.data.recipient)process.exitCode=1;});");
await writeFile(path.join(project,'tty.action.json'),JSON.stringify({schemaVersion:1,name:'terminal-check',version:'1',executable:node,packagePath:pkg,entry:'main.cjs',fields:{recipient:{type:'secret',name:'terminal-email'}},credentials:{token:'terminal-api-key'},fixed:{},target:'Synthetic terminal fixture',effects:'No external side effects',output:'status-only',timeoutMs:2000,outputBytes:4096}));
await writeFile(path.join(project,'request.json'),JSON.stringify({recipient:{$secret:'terminal-email'}}));
const python=String.raw`
import os,pty,select,subprocess,sys,time,json
node,cli,project=sys.argv[1:]
def interact(args,steps):
    master,slave=pty.openpty()
    child=subprocess.Popen([node,cli]+args,cwd=project,stdin=slave,stdout=slave,stderr=slave,close_fds=True)
    os.close(slave);output=b'';index=0;deadline=time.monotonic()+40
    try:
        while time.monotonic()<deadline:
            ready,_,_=select.select([master],[],[],0.1)
            if ready:
                try:data=os.read(master,65536)
                except OSError:break
                if not data:break
                output+=data
                if index<len(steps) and steps[index][0] in output:
                    os.write(master,steps[index][1]);index+=1
            if child.poll() is not None:break
        if child.poll() is None:child.terminate()
        status=child.wait(timeout=5)
        assert index==len(steps), 'terminal did not reach all prompts'
        return status,output
    finally:
        if child.poll() is None:child.kill();child.wait()
        os.close(master)
cases=[('email','fixture@example.test'),('phone','+1 555 0100'),('api-key','synthetic-test-token'),('text','synthetic-秘密\nmultiline')]
evidence=[];echo_checks=[]
for kind,value in cases:
    status,out=interact(['secret','set','terminal-'+kind],[(b'Type (',(kind+'\n').encode()),(b'Neutral purpose',b'Synthetic terminal acceptance\n'),(b'Ctrl+C cancels): ',value.encode()+b'\x04')])
    assert status==0,'set failed'
    echo_checks.append({'output':out.decode('utf-8'),'values':[value]})
    evidence.append({'type':kind,'exit':status,'echo':False})
status,out=interact(['secret','set','terminal-cancel'],[(b'Type (',b'text\n'),(b'Neutral purpose',b'Synthetic cancellation\n'),(b'Ctrl+C cancels): ',b'cancelled-synthetic\x03')])
assert status==4 and b'CANCELLED' in out
echo_checks.append({'output':out.decode('utf-8'),'values':['cancelled-synthetic']})
status,out=interact(['secret','action','approve','--file','tty.action.json'],[(b'Type approve to install this exact snapshot: ',b'approve\n')])
assert status==0,'human approval failed'
echo_checks.append({'output':out.decode('utf-8'),'values':[value for _,value in cases]})
result=subprocess.run([node,cli,'secret','run','terminal-check','--input','request.json','--json'],cwd=project,capture_output=True)
assert result.returncode==0 and json.loads(result.stdout)['status']=='executor_succeeded'
print(json.dumps({'cases':evidence,'cancelled':True,'humanApproval':True,'approvedActionRun':True,'echoChecks':echo_checks}))
`;
try {
 const result=spawnSync('python3',['-c',python,node,cli,project],{encoding:'utf8',timeout:180000});
 assert.equal(result.status,0,result.stderr);
 const {echoChecks,...evidence}=JSON.parse(result.stdout);
 for(const check of echoChecks)for(const value of check.values)assertNoTerminalEcho(check.output,value);
 evidence.echoCheck={policy:'normalized-newlines-and-nonempty-lines',valuesChecked:echoChecks.reduce((total,check)=>total+check.values.length,0)};
 for(const [key,file]of [['cliSha256',cli],['terminalScriptSha256',path.join(root,'scripts/secrets-terminal-spike.mjs')],['echoVerifierSha256',path.join(root,'scripts/secrets-terminal-evidence.mjs')]])evidence[key]=createHash('sha256').update(await readFile(file)).digest('hex');
 await Vault.transaction(context,false,async v=>{
  assert.equal(v.secret('terminal-text').value,'synthetic-秘密\nmultiline');
  assert.throws(()=>v.secret('terminal-cancel'));
 });
 evidence.backend='macOS Keychain';evidence.multilineRoundtrip=true;
 await writeFile(path.join(base,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{
 try{const v=JSON.parse(await readFile(path.join(context.directory,'vault.json'),'utf8'));new Entry('mancode.secrets.v1',v.keyId).deleteCredential();await rm(context.directory,{recursive:true,force:true});}catch(error){if(error.code!=='ENOENT')throw error;}
}
