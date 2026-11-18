import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
window.probeModuleStarted = true;
function Probe() {
  const canvas = useRef(null);
  const [state, setState] = useState({ phase: 'loading', invoke: null, event: null, input: '', key: '', webgl: null, error: null });
  useEffect(() => {
    let alive = true, unlisten, renderer, geometry, material, observer;
    const merge = (value) => { if (alive) setState(old => ({ ...old, ...value })); };
    (async () => {
      unlisten = await window.__TAURI__.event.listen('probe-event', event => merge({ event: event.payload }));
      if (!alive) { unlisten(); return; }
      renderer = new THREE.WebGLRenderer({ canvas: canvas.current, preserveDrawingBuffer: true, antialias: false });
      const scene = new THREE.Scene(); scene.background = new THREE.Color(0x112233);
      geometry = new THREE.PlaneGeometry(1, 1);
      material = new THREE.MeshBasicMaterial({ color: 0xff3300 });
      scene.add(new THREE.Mesh(geometry, material));
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10); camera.position.z = 2;
      const draw = () => {
        renderer.setSize(Math.max(1, canvas.current.parentElement.clientWidth), 160, false);
        renderer.render(scene, camera);
        const gl = renderer.getContext(), pixel = new Uint8Array(4);
        gl.readPixels(Math.floor(gl.drawingBufferWidth / 2), Math.floor(gl.drawingBufferHeight / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        const error = gl.getError();
        if (error !== gl.NO_ERROR) throw new Error(`WebGL readPixels error ${error}`);
        merge({ webgl: { pixel: Array.from(pixel), calls: renderer.info.render.calls, width: gl.drawingBufferWidth, height: gl.drawingBufferHeight } });
      };
      draw(); observer = new ResizeObserver(() => { try { draw(); } catch (e) { merge({ error: String(e) }); } }); observer.observe(canvas.current.parentElement);
      const value = await window.__TAURI__.core.invoke('probe_roundtrip', { value: 'react-to-rust' });
      merge({ phase: 'committed', invoke: value });
    })().catch(error => merge({ error: String(error), phase: 'failed' }));
    return () => { alive = false; unlisten?.(); observer?.disconnect(); renderer?.dispose(); geometry?.dispose(); material?.dispose(); };
  }, []);
  return <main style={{ fontFamily: 'system-ui', color: '#eee', background: '#112233', padding: 24 }}>
    <h1>Hidden WKWebView probe</h1><canvas ref={canvas} style={{ width: '100%', height: 160 }} />
    <input id="probe-input" aria-label="Synthetic input probe" value={state.input} onInput={e => { const input = e.currentTarget.value; setState(old => ({ ...old, input })); }} onKeyDown={e => { const key = e.key; setState(old => ({ ...old, key })); }}/>
    <pre id="probe-state">{JSON.stringify(state)}</pre>
  </main>;
}
createRoot(document.getElementById('root')).render(<Probe />);
