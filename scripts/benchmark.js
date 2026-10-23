import {createEntries,shuffled} from '../public/modules/queue-model.js';
const tracks=Array.from({length:10000},(_,id)=>({id:'t'+id,title:'Song '+id,artist:'Artist '+id%100,album:'Album '+id%500}));
const samples=[];
for(let i=0;i<30;i++) {
  const start=performance.now();
  tracks.filter(t=>[t.title,t.artist,t.album].join(' ').toLowerCase().includes('song 99'));
  const entries=createEntries(tracks.map(t=>t.id));shuffled(entries,entries[500].key);
  samples.push(performance.now()-start);
}
samples.sort((a,b)=>a-b);
const p95=samples[Math.floor(samples.length*.95)];
console.log(JSON.stringify({tracks:10000,runs:30,searchAndQueueP95Ms:Number(p95.toFixed(2)),budgetMs:150}));
if(p95>150) process.exitCode=1;
