import { mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';

export function writeBridgeFile(path: string, value: string | object): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
}
export function installSkill(root: string, text = 'Use this fixture skill.', allowed = 'read_file') {
  writeBridgeFile(
    join(root, 'skills', 'helper', 'SKILL.md'),
    `---\nname: helper\ndescription: Fixture skill\nallowed-tools: [${allowed}]\n---\n${text}\n`,
  );
  writeBridgeFile(join(root, 'skills', 'helper', 'support.txt'), 'Supporting package data');
}

/** A dynamic MCP catalog with richer schemas/results than a Zod object shape. */
export function installCatalogMcp(root: string) {
  const schema = {
    type: 'object',
    properties: {
      selector: { anyOf: [{ type: 'string' }, { type: 'object', additionalProperties: { type: 'string' } }] },
    },
    required: ['selector'],
    additionalProperties: false,
    minProperties: 1,
  };
  const descriptor = {
    title: 'Fixture mail',
    description: 'Read local fixture mail',
    inputSchema: schema,
    outputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
    annotations: { readOnlyHint: true },
    _meta: { fixture: 'source metadata' },
  };
  const result = {
    content: [
      { type: 'image', data: 'eA==', mimeType: 'image/png' },
      { type: 'resource', resource: { uri: 'fixture://mail/1', text: 'Fixture mail', mimeType: 'text/plain' } },
    ],
    structuredContent: { count: 1 },
    isError: false,
  };
  const catalog = join(root, 'catalog.json');
  writeBridgeFile(catalog, [
    { ...descriptor, name: 'read_mail' },
    { ...descriptor, name: 'change_catalog' },
  ]);
  const next = [
    { ...descriptor, name: 'read_calendar', title: 'Fixture calendar' },
    { ...descriptor, name: 'change_catalog' },
  ];
  const script = join(root, 'catalog-server.mjs');
  writeBridgeFile(
    script,
    `import {createInterface} from 'node:readline';
import {readFileSync,writeFileSync} from 'node:fs';
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);
 if(r.method==='initialize')send(r.id,{protocolVersion:r.params.protocolVersion,capabilities:{tools:{listChanged:true}},serverInfo:{name:'catalog-fixture',version:'1'}});
 if(r.method==='tools/list')send(r.id,{tools:JSON.parse(readFileSync(${JSON.stringify(catalog)},'utf8'))});
 if(r.method==='tools/call'){
  send(r.id,${JSON.stringify(result)});
  if(r.params.name==='change_catalog'){
   writeFileSync(${JSON.stringify(catalog)},JSON.stringify(${JSON.stringify(next)}));
   process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/tools/list_changed'})+'\\n');
  }
 }
});`,
  );
  writeBridgeFile(join(root, 'mcp.json'), { mcpServers: { fixture: { command: process.execPath, args: [script] } } });
  return { schema, descriptor, result };
}
/** Local JSON-RPC peer using the public MCP wire contract. No providers or
 * real Clanks enrollment/config are accessed. */
export function installMcp(root: string, serverName = 'fixture-mcp') {
  const script = join(root, 'server.mjs');
  const log = join(root, 'started.log');
  writeBridgeFile(
    script,
    `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
appendFileSync(${JSON.stringify(log)}, JSON.stringify({session:process.env.KAI_BRIDGE_SESSION_ID,cwd:process.cwd(),args:process.argv.slice(2)})+'\\n');
const pending=new Map();
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);
 if(r.method==='initialize') send(r.id,{protocolVersion:r.params.protocolVersion,capabilities:{tools:{listChanged:true}},serverInfo:{name:${JSON.stringify(serverName)},version:'1.0.0'}});
 if(r.method==='tools/list') send(r.id,{tools:${JSON.stringify(serverName === 'peer-agent-chat' ? ['echo', 'wait', 'peer_register', 'peer_inbox', 'peer_deregister'] : ['echo', 'wait', 'peer_register'])}.map(name=>({name,description:name,inputSchema:{type:'object',properties:{value:{type:'string'},native_session_id:{type:'string'}},additionalProperties:true}}))});
 if(r.method==='tools/call') {
  const result={content:[{type:'text',text:'fixture result'}],structuredContent:{input:r.params.arguments,session:process.env.KAI_BRIDGE_SESSION_ID,cwd:process.cwd()}};
  if(r.params.name==='peer_register') result.structuredContent.handle='peer_'+createHash('sha256').update(process.env.KAI_BRIDGE_SESSION_ID).digest('hex').slice(0,24);
  if(r.params.name==='wait') pending.set(r.id,setTimeout(()=>send(r.id,result),60000)); else send(r.id,result);
 }
 if(r.method==='notifications/cancelled'){clearTimeout(pending.get(r.params.requestId));pending.delete(r.params.requestId);}
});`,
  );
  writeBridgeFile(join(root, 'mcp.json'), {
    mcpServers: {
      fixture: { command: process.execPath, args: [script], env: { DECLARED_FIXTURE: 'fixture-secret-value' } },
    },
  });
  return {
    script,
    log,
    starts: () => {
      try {
        return readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { session: string; cwd: string; args: string[] });
      } catch {
        return [];
      }
    },
  };
}
export function installHooks(
  root: string,
  events = [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'Stop',
    'SubagentStart',
    'SubagentStop',
    'Interrupt',
    'SessionEnd',
  ],
  clanks = false,
) {
  const script = join(root, 'hook.mjs'),
    log = join(root, 'hooks.log');
  writeBridgeFile(
    script,
    `import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
let input='';for await(const chunk of process.stdin) input+=chunk;
const payload=JSON.parse(input);appendFileSync(${JSON.stringify(log)},JSON.stringify(payload)+'\\n');
let output={hookSpecificOutput:{additionalContext:'fixture context '+payload.hook_event_name}};
if(${clanks}) output.hookSpecificOutput.additionalContext="Clanks: this session's local handle is peer_"+createHash('sha256').update(payload.session_id).digest('hex').slice(0,24)+'. agent_id=fixture. native_session_id='+JSON.stringify(payload.session_id)+'.';
if(payload.tool_name==='denied') output={hookSpecificOutput:{permissionDecision:'deny',permissionDecisionReason:'fixture deny'}};
if(payload.hook_event_name==='Stop') output={decision:'block',reason:'Continue once for the fixture.'};
process.stdout.write(JSON.stringify(output));`,
  );
  writeBridgeFile(join(root, 'hooks', 'hooks.json'), {
    hooks: Object.fromEntries(
      events.map((event) => [
        event,
        [{ hooks: [{ type: 'command', command: `'${process.execPath}' '\${PLUGIN_ROOT}/hook.mjs'`, timeout: 2 }] }],
      ]),
    ),
  });
  return {
    script,
    log,
    events: () => {
      try {
        return readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as Record<string, unknown>);
      } catch {
        return [];
      }
    },
  };
}

export function installClanksFixture(root: string, nodeLauncher = false) {
  const mcp = installMcp(root, 'peer-agent-chat');
  const launcher = join(root, nodeLauncher ? 'clanks.mjs' : 'clanks');
  writeBridgeFile(launcher, `#!${process.execPath}\n${readFileSync(mcp.script, 'utf8')}`);
  chmodSync(launcher, 0o700);
  writeBridgeFile(join(root, 'mcp.json'), {
    mcpServers: {
      clanks: {
        command: nodeLauncher ? process.execPath : launcher,
        args: [...(nodeLauncher ? [launcher] : []), 'mcp', '--harness', 'codex', '--hooks'],
      },
    },
  });
  return { mcp, hooks: installHooks(root, undefined, true) };
}
