import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
// Read only the disposable App's own database. No Vault decryption or direct
// IPC. Encrypted checkpoint presence is verified before the destructive gate,
// then its usability is proved by the production App after restart.
export function observeExtensionAudit(directory) {
  assert(directory.startsWith(process.env.RUNNER_TEMP+'/shellbeam-extension-ui-'))
  return JSON.parse(execFileSync('python3',['-c',`
import pathlib,sqlite3,json,sys,base64,hashlib
root=pathlib.Path(sys.argv[1]).resolve(); paths=list((root/'data').rglob('operation_jobs.sqlite3')); assert len(paths)==1
p=paths[0]; assert p.resolve().is_relative_to(root) and not p.is_symlink()
c=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True); c.execute('PRAGMA query_only=ON')
intents=[]
for body,sealed in c.execute('SELECT body,sealed FROM monitoring_service_intents'):
 r=json.loads(body); parts=json.loads(sealed)
 encrypted=isinstance(parts,list) and len(parts)==2 and all(isinstance(v,str) for v in parts) and len(base64.b64decode(parts[0]))==12 and len(base64.b64decode(parts[1]))>16
 intents.append(dict(id=r['id'],job=r['jobId'],status=r['status'],encrypted=encrypted))
jobs=[dict(id=r[0],status=r[1],action=r[2],vault=r[3]) for r in c.execute("SELECT job_id,status,action,vault_id FROM operation_jobs WHERE action LIKE 'monitoring.%' ORDER BY queued_at,job_id")]
assert all(r['vault'] for r in jobs)
inventory=list((root/'data').rglob('workspace_inventory.sqlite3')); assert len(inventory)==1
assert inventory[0].resolve().is_relative_to(root) and not inventory[0].is_symlink()
i=sqlite3.connect(inventory[0].as_uri()+'?mode=ro',uri=True); i.execute('PRAGMA query_only=ON')
refs=list(i.execute('SELECT id,vault_id,credential_ref FROM komari_integrations ORDER BY id')); assert len(refs)==2
vaults=list((root/'data').rglob('vault_*.json')); assert len(vaults)==1 and not vaults[0].is_symlink() and vaults[0].resolve().is_relative_to(root)
proof=hashlib.sha256(json.dumps(refs).encode()+vaults[0].read_bytes()).hexdigest()
print(json.dumps(dict(intents=intents,jobs=jobs,credentialFingerprint=proof)))
`,directory],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000}))
}
