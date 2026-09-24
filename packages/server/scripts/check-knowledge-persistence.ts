import '../src/load-env.js';
import pg from 'pg';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
if (!process.argv.includes('--local') || !['localhost','127.0.0.1'].includes(process.env.PG_HOST ?? 'localhost')) throw new Error('Local only');
const arg = process.argv.indexOf('--docker-container');
if (arg < 0 || !process.argv[arg+1]) throw new Error('Explicit existing container required');
const container = process.argv[arg+1];
const config = {host:process.env.PG_HOST,port:Number(process.env.PG_PORT ?? 5432),user:process.env.PG_USER,password:process.env.PG_PASSWORD,database:process.env.PG_DATABASE};
const root=fileURLToPath(new URL('../../../',import.meta.url));
const id=randomUUID(), content=Buffer.from('knowledge restart persistence fixture');
const directory=resolve(root,'data/knowledge',id), path=resolve(directory,createHash('sha256').update(content).digest('hex'));
let pool=new pg.Pool(config);
try {
  await pool.query("INSERT INTO users(id,name) VALUES($1,'restart fixture')",[id]);
  await mkdir(directory,{recursive:true}); await writeFile(path,content,{mode:0o600});
  const version=(await pool.query('SELECT max(version) AS version FROM schema_migrations')).rows[0].version;
  await pool.end();
  await promisify(execFile)('docker',['restart',container]);
  let ready=false;
  for(let attempt=0;attempt<30;attempt++) {
    const probe=new pg.Pool({...config,connectionTimeoutMillis:1000});
    try { await probe.query('SELECT 1'); ready=true; } catch {} finally { await probe.end(); }
    if(ready) break; await new Promise(r=>setTimeout(r,1000));
  }
  if(!ready) throw new Error('Existing PostgreSQL failed to restart');
  pool=new pg.Pool(config);
  if((await pool.query('SELECT name FROM users WHERE id=$1',[id])).rows[0]?.name!=='restart fixture' || !(await readFile(path)).equals(content) || (await pool.query('SELECT max(version) AS version FROM schema_migrations')).rows[0].version!==version) throw new Error('Persistence mismatch');
  await mkdir(resolve(root,'tests/eval/results'),{recursive:true});
  const report={finished:new Date().toISOString(),existingContainer:container,newContainers:0,databaseRowPersisted:true,hostPrivateFilePersisted:true,schemaVersion:version};
  await writeFile(resolve(root,'tests/eval/results/persistence.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify(report));
} finally { if(!pool.ended) {await pool.query('DELETE FROM users WHERE id=$1',[id]); await pool.end();} await rm(directory,{recursive:true,force:true}); }
