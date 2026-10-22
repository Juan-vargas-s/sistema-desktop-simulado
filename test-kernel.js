// Prueba automática del kernel simulado (npm run test-kernel)
const Kernel = require('./kernel.js');

const k = new Kernel();
k.boot();
k.paused = false;

const rand = (n) => Math.floor(Math.random() * n);
let deadlocks = 0, starved = 0, ctx = 0;
for (let t = 0; t < 4000; t++) {
  k.tick();
  // mantener una población activa mínima de 12 procesos (como un SO real)
  if (t % 50 === 0 && k.processes.filter((p) => p.state !== 'terminated').length < 12) {
    const kinds = ['app', 'service', 'system'];
    k.createProcess({ name: `daemon-${t}-${rand(99)}`, kind: kinds[rand(kinds.length)], burst: 60 + rand(90) });
  }
  if (k.metrics.deadlocksDetected > deadlocks) deadlocks = k.metrics.deadlocksDetected;
    if (k.metrics.starved > starved) starved = k.metrics.starved;
  ctx = k.metrics.contextSwitches;
}

const ms = k.memStats();
const sc = k.stateCounts();
console.log('==== RESULTADO DE LA PRUEBA ====');
console.log({ ticks: k.ticks, ctxSwitches: ctx, deadlocks, starved, admisiones: k.metrics.admissions, terminados: k.metrics.terminated, compactaciones: k.metrics.compactations, semOps: k.metrics.semWaitOps + '/' + k.metrics.semSignalOps });
console.log('estados:', JSON.stringify(sc));
console.log('memoria:', JSON.stringify({ usedMB: ms.usedMB, freeMB: ms.freeMB, holes: ms.holes, fragInternaMB: ms.internalFragMB, fragExternaPct: +ms.fragExternaPct.toFixed(1) }));
console.log('buffer compartido productor/consumidor:', JSON.stringify(k.buffer));
console.log('dispositivos:', k.devices.map((d) => `${d.id}:${d.allocated.map((x) => (x === null ? '-' : x)).join(',')} q=${d.queue.length}`).join(' | '));
console.log('eventos de interbloqueo/inanicion:');
for (const l of k.log) if (l.type === 'DEADLOCK' || l.type === 'starve') console.log('  t' + l.tick, l.type, '-', l.text);

// Verificaciones básicas
const assert = require('assert');
assert(k.metrics.created >= 14, 'deben existir >=14 procesos');
assert(k.metrics.admissions > 0, 'debe haber admisiones');
assert(k.metrics.contextSwitches > 0, 'debe haber alternancia (quantum)');
assert(k.processes.some((p) => p.state === 'terminated'), 'debe finalizar procesos');
assert(ms.totalMB === 1024, 'memoria total 1024 MB');
console.log('\n✔ TODAS LAS VERIFICACIONES PASARON');
