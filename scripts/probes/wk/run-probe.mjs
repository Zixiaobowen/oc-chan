// node scripts/probes/wk/run-probe.mjs /absolute/path/to/oc-wk-probe /absolute/evidence/directory
// Executes a real hidden WKWebView, native AppKit input, and separately labeled synthetic DOM input.
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { readFile, writeFile, mkdir, lstat, readdir, unlink, rmdir } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import assert from 'node:assert/strict';
const [binary, evidence] = process.argv.slice(2);
if (!binary || !evidence || !isAbsolute(binary) || !isAbsolute(evidence)) throw new Error('Absolute binary and evidence directory required');
await mkdir(evidence, { recursive: true });
const child = spawn(binary, [], { env: { ...process.env, OC_CHAN_HEADLESS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', stderrOmitted = 0, socket, sequence = 0, pending, driverDirectory, directoryIdentity, invoke;
const exited = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
child.stderr.on('data', data => { const next = stderr + data; stderrOmitted += Math.max(0, Buffer.byteLength(next) - 64 * 1024); stderr = next.slice(-64 * 1024); });
const timeout = (ms, label) => new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(label)), ms); timer.unref(); });
const evidenceData = { inputKind: 'native AppKit responder mouse/text/key, followed by separately labeled synthetic DOM InputEvent and KeyboardEvent', results: [] };
try {
  const directory = await Promise.race([new Promise((resolve, reject) => {
    child.stdout.on('data', data => {
      stdout += data;
      if (stdout.length > 64 * 1024) { reject(new Error('startup output exceeded 64KiB')); return; }
      for (const line of stdout.split('\n').slice(0, -1)) {
        if (line.startsWith('{"driverDirectory"')) { try { resolve(JSON.parse(line).driverDirectory); } catch (e) { reject(e); } }
      }
    });
    child.once('exit', () => reject(new Error('probe exited before driver ready')));
  }), timeout(30000, 'startup deadline')]);
  assert.match(directory, new RegExp(`^/tmp/ocwk-${child.pid}-[0-9a-f]{12}$`));
  directoryIdentity = await lstat(directory);
  assert.ok(directoryIdentity.isDirectory() && !directoryIdentity.isSymbolicLink());
  assert.equal(directoryIdentity.uid, process.getuid());
  assert.equal(directoryIdentity.mode & 0o777, 0o700);
  driverDirectory = directory;
  evidenceData.instance = { binary, pid: child.pid, directory, dev: directoryIdentity.dev, ino: directoryIdentity.ino };
  const token = await readFile(resolve(directory, 'token'), 'utf8');
  socket = connect(resolve(directory, 'driver.sock'));
  let buffer = '';
  socket.on('data', data => {
    buffer += data;
    if (buffer.length > 1024 * 1024 + 1) { pending?.reject(new Error('response limit')); socket.destroy(); return; }
    const end = buffer.indexOf('\n');
    if (end >= 0) { try { const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); pending?.resolve(frame); } catch (e) { pending?.reject(e); } }
  });
  socket.on('error', error => pending?.reject(error));
  socket.on('close', () => pending?.reject(new Error('driver disconnected')));
  await Promise.race([new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); }), timeout(5000, 'connect deadline')]);
  async function call(command, fields = {}) {
    const id = ++sequence;
    const promise = new Promise((resolve, reject) => { pending = { resolve, reject }; });
    socket.write(JSON.stringify({ token, id, command, ...fields }) + '\n');
    const frame = await Promise.race([promise, timeout(16000, `${command} deadline`)]);
    pending = undefined;
    assert.equal(frame.id, id); assert.equal(frame.result.ok, true, JSON.stringify(frame));
    return frame.result.value;
  }
  invoke = call;
  const inspect = await call('inspect');
  assert.equal(inspect.visible, false); assert.equal(inspect.key, false); assert.equal(inspect.appActive, false); assert.equal(inspect.activationPolicy, 2);
  evidenceData.results.push({ inspect });
  // Native window creation precedes initial navigation. Wait for that document
  // before evaluating any script, then wait for the real React/IPC/WebGL commit.
  let nativeDocument = inspect;
  const documentDeadline = Date.now() + 20000;
  while (nativeDocument.loading || !nativeDocument.url || nativeDocument.url === 'about:blank') {
    if (Date.now() >= documentDeadline) throw new Error(`native document load deadline: ${JSON.stringify(nativeDocument)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
    nativeDocument = await call('inspect');
  }
  evidenceData.results.push({ nativeDocument });
  let state;
  const deadline = Date.now() + 20000;
  do {
    state = await call('eval', { script: "return JSON.stringify(document.getElementById('probe-state') ? JSON.parse(document.getElementById('probe-state').textContent) : {phase:'loading'})" });
    if (state.error) throw new Error(state.error);
    if (state.phase === 'committed' && state.event) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  evidenceData.lastState = state;
  if (state.phase !== 'committed') evidenceData.startupDocument = await call('eval', { script: "return JSON.stringify({url:location.href,ready:document.readyState,html:document.documentElement.outerHTML.slice(0,8192),tauri:typeof window.__TAURI__,errors:window.probeErrors||[]})" });
  assert.equal(state.invoke, 'rust-invoke:react-to-rust'); assert.equal(state.event, 'rust-event:react-to-rust');
  assert.ok(state.webgl.calls > 0); assert.ok(state.webgl.pixel[0] > 200 && state.webgl.pixel[1] < 100 && state.webgl.pixel[3] === 255);
  evidenceData.results.push({ reactInvokeEventWebgl: state });
  const asyncEval = await call('eval', { script: "await new Promise(resolve => setTimeout(resolve, 20)); return JSON.stringify({awaited:true});" });
  assert.equal(asyncEval.awaited, true);
  evidenceData.results.push({ asyncEval });
  const inputObservation = { beforeNative: await call('inspect') };
  evidenceData.nativeInputObservation = inputObservation;
  const observeInput = () => call('eval', { script: `
    const input=document.getElementById('probe-input');
    const active=document.activeElement;
    return JSON.stringify({activeElement:active ? {id:active.id,tag:active.tagName}:null,
      documentFocused:document.hasFocus(),inputDOMvalue:input.value,
      events:window.__ocProbeInputObservation.events});
  ` });
  const point = await call('eval', { script: `
    const observation={events:[],abort:new AbortController()};
    window.__ocProbeInputObservation=observation;
    for(const type of ['mousedown','mouseup','click','focusin','keydown','beforeinput','input']) {
      document.addEventListener(type,event=>{
        if(observation.events.length>=16)return;
        observation.events.push({type:event.type,isTrusted:event.isTrusted,
          target:String(event.target?.id||event.target?.tagName||'').slice(0,128),
          x:event.clientX??null,y:event.clientY??null,key:String(event.key||'').slice(0,64)});
      },{capture:true,signal:observation.abort.signal});
    }
    const r=document.getElementById('probe-input').getBoundingClientRect();
    const x=r.left+r.width/2,y=r.top+r.height/2;
    const hit=document.elementFromPoint(x,y);
    const viewport=window.visualViewport;
    return JSON.stringify({x,y,hit:hit ? {id:hit.id,tag:hit.tagName}:null,
      rect:{x:r.x,y:r.y,width:r.width,height:r.height},
      viewport:{width:innerWidth,height:innerHeight,devicePixelRatio,scrollX,scrollY,
        visual:viewport ? {width:viewport.width,height:viewport.height,scale:viewport.scale,
          offsetLeft:viewport.offsetLeft,offsetTop:viewport.offsetTop}:null}});
  ` });
  inputObservation.point = point;
  inputObservation.beforeDOM = await observeInput();
  await call('mouse', { input: { kind: 'down', ...point } });
  await call('mouse', { input: { kind: 'up', ...point } });
  // AppKit dispatch acknowledges enqueueing, not WebProcess DOM focus. Observe
  // focus before text insertion; never synthesize focus or retry mouse events.
  const focusDeadline = Date.now() + 1000;
  do {
    inputObservation.afterMouseDOM = await observeInput();
    if (inputObservation.afterMouseDOM.activeElement?.id === 'probe-input') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < focusDeadline);
  inputObservation.afterMouseNative = await call('inspect');
  await call('text', { input: { text: 'native-value' } });
  await call('key', { input: { key: 'Enter' } });
  let nativeInput;
  const inputDeadline = Date.now() + 5000;
  do {
    nativeInput = await call('eval', { script: "return JSON.stringify(JSON.parse(document.getElementById('probe-state').textContent));" });
    if (nativeInput.input === 'native-value' && nativeInput.key === 'Enter') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < inputDeadline);
  inputObservation.afterInputDOM = await observeInput();
  inputObservation.afterInputNative = await call('inspect');
  evidenceData.results.push({ appKitResponderInput: nativeInput });
  await call('eval', { script: "window.__ocProbeInputObservation.abort.abort();delete window.__ocProbeInputObservation;return JSON.stringify({observationReleased:true});" });
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify(evidenceData, null, 2) + '\n');
  assert.equal(nativeInput.input, 'native-value'); assert.equal(nativeInput.key, 'Enter');
  const nativeEvents = inputObservation.afterInputDOM.events;
  const nativeClick = nativeEvents.find(event => event.type === 'click');
  assert(nativeClick?.isTrusted && nativeClick.target === 'probe-input', 'native click must reach the input');
  assert(Math.abs(nativeClick.x - point.x) <= 1 && Math.abs(nativeClick.y - point.y) <= 1, 'native click must preserve CSS viewport coordinates within pixel rounding');
  assert(nativeEvents.some(event => event.type === 'input' && event.isTrusted && event.target === 'probe-input'), 'native insertion must emit trusted input');
  assert(nativeEvents.some(event => event.type === 'keydown' && event.isTrusted && event.target === 'probe-input' && event.key === 'Enter'), 'native Enter must reach the input');
  await call('eval', { script: "return JSON.stringify((() => { const el=document.getElementById('probe-input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'synthetic-value'); el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'synthetic-value'})); el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return {synthetic:true}; })())" });
  const inputState = await call('eval', { script: "return JSON.stringify(JSON.parse(document.getElementById('probe-state').textContent))" });
  assert.equal(inputState.input, 'synthetic-value'); assert.equal(inputState.key, 'Enter');
  evidenceData.results.push({ syntheticInput: inputState });
  const resized = await call('resize', { width: 1100, height: 720 });
  assert.equal(resized.width, 1100); assert.equal(resized.height, 720); assert.equal(resized.visible, false);
  evidenceData.results.push({ resized });
  const snapshot = await call('capture');
  const png = Buffer.from(snapshot.pngBase64, 'base64');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); assert.ok(snapshot.width > 0 && snapshot.height > 0);
  await writeFile(resolve(evidence, 'hidden-wk.png'), png);
  evidenceData.results.push({ nativeSnapshot: { width: snapshot.width, height: snapshot.height, bytes: png.length } });
  await call('quit'); socket.end();
  const exit = await Promise.race([exited, timeout(20000, 'exit deadline')]); assert.equal(exit.code, 0);
  evidenceData.exit = exit; evidenceData.ok = true;
} catch (error) {
  evidenceData.ok = false; evidenceData.error = String(error); process.exitCode = 1;
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    if (invoke && socket && !socket.destroyed) {
      try { await invoke('quit'); await Promise.race([exited, timeout(20000, 'graceful exit deadline')]); }
      catch (error) { evidenceData.gracefulExitError = String(error); }
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      try { await Promise.race([exited, timeout(5000, 'termination deadline')]); }
      catch (error) { evidenceData.terminationError = String(error); child.kill('SIGKILL'); await exited; }
    }
  }
  socket?.destroy();
  if (driverDirectory && directoryIdentity) {
    try {
      const current = await lstat(driverDirectory);
      assert.ok(current.isDirectory() && !current.isSymbolicLink() && current.dev === directoryIdentity.dev && current.ino === directoryIdentity.ino);
      const names = await readdir(driverDirectory);
      assert.ok(names.every(name => ['driver.sock', 'token'].includes(name)), 'unexpected instance file; preserve directory');
      for (const name of names) await unlink(resolve(driverDirectory, name));
      await rmdir(driverDirectory);
      evidenceData.instanceCleaned = true;
    } catch (error) {
      if (error.code === 'ENOENT') evidenceData.instanceCleaned = true;
      else { evidenceData.cleanupError = String(error); evidenceData.ok = false; process.exitCode = 1; }
    }
  }
  evidenceData.stderr = stderr;
  evidenceData.stderrOmittedBytes = stderrOmitted;
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify(evidenceData, null, 2) + '\n');
  console.log(JSON.stringify(evidenceData, null, 2));
}
