import { createHash, createPrivateKey, sign } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const artifactPayload = (manifest) => JSON.stringify({artifactId:manifest.artifactId,version:manifest.version,platform:manifest.platform,architecture:manifest.architecture,url:manifest.url,sha256:manifest.sha256.toLowerCase(),sizeBytes:manifest.sizeBytes??null})
export const releasePayload = (manifest) => JSON.stringify({releaseId:manifest.releaseId,channel:manifest.channel,publishedAt:manifest.publishedAt,expiresAt:manifest.expiresAt??null,minAgentVersion:manifest.minAgentVersion??null,maxAgentVersion:manifest.maxAgentVersion??null,rollout:manifest.rollout??{percentage:100,salt:'default'},previousSha256:manifest.previousSha256??null,rollbackOf:manifest.rollbackOf??null,artifactId:manifest.artifact.artifactId,artifactVersion:manifest.artifact.version,artifactSha256:manifest.artifact.sha256.toLowerCase()})
export function signedRelease({bytes,version,platform,architecture,url,channel='stable',artifactKey,releaseKey,now=Date.now(),rolloutPercentage=100,previousSha256}) {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)||!['linux','macos'].includes(platform)||!['x86_64','aarch64'].includes(architecture)||!['stable','preview','canary'].includes(channel)) throw new Error('release_arguments_invalid')
  const parsed=new URL(url);if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.hash)throw new Error('release_url_invalid')
  if(bytes.length===0||bytes.length>32*1024*1024)throw new Error('artifact_size_invalid')
  if(!Number.isInteger(rolloutPercentage)||rolloutPercentage<0||rolloutPercentage>100)throw new Error('release_rollout_invalid')
  if(previousSha256&&!/^[a-f0-9]{64}$/i.test(previousSha256))throw new Error('previous_hash_invalid')
  const artifactSigningKey=createPrivateKey(artifactKey);const releaseSigningKey=createPrivateKey(releaseKey)
  if(artifactSigningKey.asymmetricKeyType!=='ed25519'||releaseSigningKey.asymmetricKeyType!=='ed25519')throw new Error('ed25519_keys_required')
  const artifact={artifactId:`shellbeam-agent-${platform}-${architecture}`,version,platform,architecture,url:parsed.toString(),sha256:createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length,signatureAlgorithm:'ed25519'}
  artifact.signature=sign(null,Buffer.from(artifactPayload(artifact)),artifactSigningKey).toString('base64')
  const release={releaseId:`agent-${version}-${platform}-${architecture}`,channel,publishedAt:now,expiresAt:now+90*24*60*60*1000,rollout:{percentage:rolloutPercentage,salt:`agent-${version}`},...(previousSha256?{previousSha256}:{}),artifact,releaseSignatureAlgorithm:'ed25519'}
  release.releaseSignature=sign(null,Buffer.from(releasePayload(release)),releaseSigningKey).toString('base64')
  return release
}
async function main(){
  const args=process.argv.slice(2);const option=(name)=>args[args.indexOf(name)+1]
  for(const name of ['--input-dir','--output','--version','--base-url'])if(!args.includes(name))throw new Error(`${name}_required`)
  if(!process.env.AGENT_ARTIFACT_SIGNING_KEY_PEM||!process.env.AGENT_RELEASE_SIGNING_KEY_PEM)throw new Error('signing_keys_required')
  const input=resolve(option('--input-dir'));const base=option('--base-url').replace(/\/$/,'');const manifests=[]
  for(const [platform,architecture] of [['linux','x86_64'],['linux','aarch64'],['macos','x86_64'],['macos','aarch64']]){
    const filename=`shellbeam-agent-${platform}-${architecture}`
    const bytes=await readFile(resolve(input,filename))
    manifests.push(signedRelease({bytes,version:option('--version'),platform,architecture,url:`${base}/${filename}`,channel:args.includes('--channel')?option('--channel'):'stable',artifactKey:process.env.AGENT_ARTIFACT_SIGNING_KEY_PEM,releaseKey:process.env.AGENT_RELEASE_SIGNING_KEY_PEM}))
  }
  const output=resolve(option('--output'));await mkdir(resolve(output,'..'),{recursive:true});await writeFile(output,JSON.stringify({schemaVersion:1,manifests},null,2)+'\n',{mode:0o644})
  console.log(`Signed ${manifests.length} artifacts into ${basename(output)}`)
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main()
