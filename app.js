import * as maplibregl from 'https://unpkg.com/maplibre-gl@6.11.2/dist/maplibre-gl.mjs';

const START_QUERY = 'Löher Weg 2A, 58540 Meinerzhagen, Deutschland';
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const TERRAIN_TILEJSON = 'https://tiles.mapterhorn.com/tilejson.json';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const OSRM = 'https://router.project-osrm.org/route/v1/driving';
const OVERPASS = 'https://overpass-api.de/api/interpreter';

const $ = id => document.getElementById(id);
const el = Object.fromEntries([...document.querySelectorAll('[id]')].map(x => [x.id, x]));

const vehicles = {
  family:{name:'Familienwagen',ps:150,max:205,acc:12,brake:36,tank:58,cons:7.4,css:'car-family'},
  suv:{name:'SUV',ps:230,max:225,acc:14,brake:39,tank:72,cons:9.3,css:'car-suv'},
  sport:{name:'Sportwagen',ps:480,max:300,acc:21,brake:50,tank:68,cons:12.1,css:'car-sport'},
  super:{name:'Supersportwagen',ps:780,max:345,acc:27,brake:56,tank:75,cons:15.2,css:'car-super'}
};

let vehicle = vehicles.family;
let map, miniMap;
let START = null, DEST = null;
let route = {coords:[],cum:[],distance:0,duration:0,steps:[],stepStarts:[]};
let progress = 0, traveled = 0, speed = 0, fuel = vehicle.tank;
let paused = false, overview = false, steer = 0, tiltSteer = 0, tiltEnabled = false;
let gasPressed = false, brakePressed = false, lastFrame = performance.now();
let fuelStations = [], lastFuelQueryAt = 0, lastFuelQueryPos = null;
let lastGeocodeAt = 0, currentRoadName = '', destinationLabel = 'Kölner Dom, Köln';
let trafficPhase = 0;

function showLoading(text='Laden …'){ el.loadingText.textContent=text; el.loading.classList.remove('hidden'); el.errorOverlay.classList.add('hidden'); }
function hideLoading(){ el.loading.classList.add('hidden'); }
function showError(message){ hideLoading(); el.errorText.textContent=message; el.errorOverlay.classList.remove('hidden'); }
function clamp(v,min,max){ return Math.max(min,Math.min(max,v)); }
function fmtKm(m){ if(m<1000) return `${Math.round(m)} m`; const km=m/1000; return `${km<100?km.toFixed(1):Math.round(km)}`.replace('.',',')+' km'; }
function fmtDuration(sec){ const min=Math.max(0,Math.round(sec/60)); return min<60?`${min} min`:`${Math.floor(min/60)} h ${min%60} min`; }
function hav(a,b){ const R=6371000,r=Math.PI/180,p1=a[1]*r,p2=b[1]*r,dp=(b[1]-a[1])*r,dl=(b[0]-a[0])*r; const x=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2; return 2*R*Math.atan2(Math.sqrt(x),Math.sqrt(1-x)); }
function bearing(a,b){ const r=Math.PI/180,p1=a[1]*r,p2=b[1]*r,dl=(b[0]-a[0])*r; const y=Math.sin(dl)*Math.cos(p2),x=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl); return (Math.atan2(y,x)*180/Math.PI+360)%360; }
function interp(a,b,t){ return [a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]; }

async function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }
async function geocode(q){
  const waitMs = Math.max(0,1100-(Date.now()-lastGeocodeAt));
  if(waitMs) await wait(waitMs);
  lastGeocodeAt = Date.now();
  const u = `${NOMINATIM}?format=jsonv2&limit=1&addressdetails=1&q=${encodeURIComponent(q)}`;
  const res = await fetch(u,{headers:{'Accept':'application/json','Accept-Language':'de'}});
  if(!res.ok) throw new Error(`Adresssuche nicht erreichbar (HTTP ${res.status}).`);
  const data = await res.json();
  if(!Array.isArray(data)||!data.length) throw new Error(`Adresse/Ziel nicht gefunden: ${q}`);
  const lon=Number(data[0].lon),lat=Number(data[0].lat);
  if(!Number.isFinite(lon)||!Number.isFinite(lat)) throw new Error('Adressdienst lieferte ungültige Koordinaten.');
  return {coord:[lon,lat],label:data[0].display_name||q};
}

async function getRoute(a,b){
  const u = `${OSRM}/${a[0]},${a[1]};${b[0]},${b[1]}?overview=full&geometries=geojson&steps=true&annotations=false`;
  const res = await fetch(u);
  if(!res.ok) throw new Error(`Routingdienst nicht erreichbar (HTTP ${res.status}).`);
  const j = await res.json();
  if(j.code!=='Ok'||!j.routes?.[0]) throw new Error(j.message||'Keine befahrbare reale Route gefunden.');
  return j.routes[0];
}

function buildRoute(r){
  route.coords = r.geometry.coordinates;
  route.distance = r.distance;
  route.duration = r.duration;
  route.steps = r.legs.flatMap(l=>l.steps||[]);
  route.stepStarts=[]; let sd=0; for(const s of route.steps){ route.stepStarts.push(sd); sd += s.distance||0; }
  route.cum=[0]; for(let i=1;i<route.coords.length;i++) route.cum[i]=route.cum[i-1]+hav(route.coords[i-1],route.coords[i]);
  const raw=route.cum.at(-1)||route.distance; const f=route.distance/raw; if(Number.isFinite(f)&&Math.abs(f-1)>.003) route.cum=route.cum.map(x=>x*f);
}

function pointAt(m){
  if(!route.coords.length) return {coord:START?.coord||[7.63,51.10],bearing:0,index:0};
  m=clamp(m,0,route.distance); let lo=0,hi=route.cum.length-1;
  while(lo<hi){const mid=(lo+hi)>>1;if(route.cum[mid]<m)lo=mid+1;else hi=mid;}
  const i=Math.max(1,lo),a=route.coords[i-1],b=route.coords[i],d0=route.cum[i-1],d1=route.cum[i],t=d1===d0?0:(m-d0)/(d1-d0);
  return {coord:interp(a,b,t),bearing:bearing(a,b),index:i};
}
function routeBBox(){ let w=Infinity,s=Infinity,e=-Infinity,n=-Infinity; for(const c of route.coords){w=Math.min(w,c[0]);s=Math.min(s,c[1]);e=Math.max(e,c[0]);n=Math.max(n,c[1]);} return [w,s,e,n]; }

function arrowForStep(step){
  const m=step?.maneuver||{}; const mod=m.modifier||'';
  if(m.type==='arrive') return '●'; if(m.type==='roundabout'||m.type==='rotary') return '⟳';
  if(mod.includes('left')) return '↰'; if(mod.includes('right')) return '↱'; if(mod==='uturn') return '↶'; return '↑';
}
function stepInfo(){
  if(!route.steps.length) return {step:null,dist:route.distance-progress,text:'Route folgen'};
  let idx=route.steps.length-1;
  for(let i=0;i<route.steps.length;i++){ const end=route.stepStarts[i]+(route.steps[i].distance||0); if(progress<=end){idx=i;break;} }
  const st=route.steps[idx], m=st.maneuver||{}, d=Math.max(0,route.stepStarts[idx]+(st.distance||0)-progress);
  const type={depart:'Start',arrive:'Ziel',turn:'Abbiegen',continue:'Weiter',merge:'Einfädeln','on ramp':'Auffahrt','off ramp':'Ausfahrt',roundabout:'Kreisverkehr',rotary:'Kreisverkehr','new name':'Weiter'}[m.type]||'Weiter';
  const mod={left:'links',right:'rechts','slight left':'leicht links','slight right':'leicht rechts','sharp left':'scharf links','sharp right':'scharf rechts',straight:'geradeaus',uturn:'wenden'}[m.modifier]||'';
  currentRoadName=st.name||currentRoadName;
  return {step:st,dist:d,text:`${type}${mod?' '+mod:''}${st.name?' · '+st.name:''}`};
}

function updateHud(){
  const pct=clamp(Math.round(fuel/vehicle.tank*100),0,100);
  el.fuelPct.textContent=pct; el.rangeText.textContent=`${Math.max(0,Math.round(fuel/vehicle.cons*100))} km`;
  el.speed.textContent=Math.round(Math.abs(speed)); el.gear.textContent=speed<-1?'R':speed>1?'D':'N';
  const arc=clamp(Math.abs(speed)/vehicle.max,0,1)*280; el.speedArc.style.setProperty('--arc',`${arc}deg`);
  const info=stepInfo(); el.turnArrow.textContent=arrowForStep(info.step); el.navInstruction.textContent=info.text;
  const remain=Math.max(0,route.distance-progress); const est=route.duration*(remain/Math.max(1,route.distance));
  el.navDetail.textContent=`${fmtKm(info.dist)} · Ziel ${fmtKm(remain)} · ${fmtDuration(est)}`;
  el.routeState.textContent=`Start: ${START?.label||START_QUERY}\nZiel: ${DEST?.label||destinationLabel}\nRoute: ${fmtKm(route.distance)}`;
}
function updateClock(){ el.clock.textContent=new Intl.DateTimeFormat('de-DE',{hour:'2-digit',minute:'2-digit'}).format(new Date()); }

function sourceDataLine(){ return {type:'Feature',properties:{},geometry:{type:'LineString',coordinates:route.coords}}; }
function addRouteLayers(target){
  if(!route.coords.length) return;
  const data=sourceDataLine();
  if(target.getSource('route')) target.getSource('route').setData(data); else {
    target.addSource('route',{type:'geojson',data});
    target.addLayer({id:'route-casing',type:'line',source:'route',layout:{'line-join':'round','line-cap':'round'},paint:{'line-color':'#0b2343','line-width':target===miniMap?7:9,'line-opacity':.84}});
    target.addLayer({id:'route-line',type:'line',source:'route',layout:{'line-join':'round','line-cap':'round'},paint:{'line-color':'#2e91ff','line-width':target===miniMap?4:5}});
  }
}
function addEndpoints(target){
  if(!START||!DEST)return;
  const fc={type:'FeatureCollection',features:[{type:'Feature',properties:{kind:'start'},geometry:{type:'Point',coordinates:START.coord}},{type:'Feature',properties:{kind:'dest'},geometry:{type:'Point',coordinates:DEST.coord}}]};
  if(target.getSource('endpoints')) target.getSource('endpoints').setData(fc); else {target.addSource('endpoints',{type:'geojson',data:fc});target.addLayer({id:'endpoints',type:'circle',source:'endpoints',paint:{'circle-radius':6,'circle-color':['match',['get','kind'],'start','#42d17d','#ffcc35'],'circle-stroke-width':2,'circle-stroke-color':'#0b1117'}});}
}
function addTerrainAndBuildings(){
  try{ if(!map.getSource('terrain')) map.addSource('terrain',{type:'raster-dem',url:TERRAIN_TILEJSON,tileSize:512}); map.setTerrain({source:'terrain',exaggeration:1.05}); }catch(e){ console.warn('Terrain',e); }
  try{
    const srcs=map.getStyle().sources||{}; const vector=Object.keys(srcs).find(k=>srcs[k].type==='vector');
    if(vector&&!map.getLayer('ed-buildings')){ const before=(map.getStyle().layers||[]).find(l=>l.type==='symbol')?.id; map.addLayer({id:'ed-buildings',type:'fill-extrusion',source:vector,'source-layer':'building',minzoom:14,paint:{'fill-extrusion-color':'#c2beb5','fill-extrusion-height':['coalesce',['to-number',['get','render_height']],['*',['to-number',['get','levels']],3],6],'fill-extrusion-base':['coalesce',['to-number',['get','render_min_height']],0],'fill-extrusion-opacity':.75}},before); }
  }catch(e){ console.warn('Buildings',e); }
}

async function queryFuelAround(coord,force=false){
  const now=Date.now(); if(!force&&now-lastFuelQueryAt<45000&&lastFuelQueryPos&&hav(coord,lastFuelQueryPos)<3500) return;
  lastFuelQueryAt=now; lastFuelQueryPos=coord;
  const lon=coord[0],lat=coord[1],d=.055;
  const q=`[out:json][timeout:15];(node["amenity"="fuel"](${lat-d},${lon-d},${lat+d},${lon+d});way["amenity"="fuel"](${lat-d},${lon-d},${lat+d},${lon+d}););out center tags 50;`;
  try{
    const res=await fetch(OVERPASS,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'},body:'data='+encodeURIComponent(q)}); if(!res.ok) return;
    const j=await res.json(); fuelStations=(j.elements||[]).map(x=>({coord:[x.lon??x.center?.lon,x.lat??x.center?.lat],name:x.tags?.name||x.tags?.brand||'Tankstelle'})).filter(x=>Number.isFinite(x.coord[0])&&Number.isFinite(x.coord[1]));
    const fc={type:'FeatureCollection',features:fuelStations.map(s=>({type:'Feature',properties:{name:s.name},geometry:{type:'Point',coordinates:s.coord}}))};
    for(const target of [map,miniMap]){ if(!target?.isStyleLoaded()) continue; if(target.getSource('fuel')) target.getSource('fuel').setData(fc); else { target.addSource('fuel',{type:'geojson',data:fc}); target.addLayer({id:'fuel',type:'circle',source:'fuel',paint:{'circle-radius':target===miniMap?5:7,'circle-color':'#ffc82f','circle-stroke-width':2,'circle-stroke-color':'#3c2d00'}}); } }
  }catch(e){ console.warn('Fuel query',e); }
}
function nearestFuel(coord){ let best=null,dist=Infinity; for(const s of fuelStations){const d=hav(coord,s.coord);if(d<dist){dist=d;best=s;}} return best?{...best,dist}:null; }

function updateCamera(){
  if(!route.coords.length||overview) return;
  const carP=pointAt(progress),ahead=pointAt(Math.min(route.distance,progress+24+Math.abs(speed)*.10));
  const steering=Math.abs(tiltSteer)>.08?tiltSteer:steer;
  map.jumpTo({center:ahead.coord,bearing:carP.bearing+steering*2.2,pitch:80,zoom:17.35});
  miniMap?.jumpTo({center:carP.coord,bearing:0,pitch:0,zoom:14.8});
  el.playerCar.style.left=`calc(50% + ${clamp(steering,-1,1)*5.2}vw)`;
}
function showOverview(){ overview=true; const [w,s,e,n]=routeBBox(); map.fitBounds([[w,s],[e,n]],{padding:60,duration:700,pitch:35}); el.drawer.classList.remove('open'); }
function returnDriveView(){ overview=false; updateCamera(); }

async function setDestination(text){
  showLoading('Ziel wird über OpenStreetMap gesucht …');
  try{
    if(!START){ START=await geocode(START_QUERY); await wait(1100); }
    DEST=await geocode(text); destinationLabel=text;
    showLoading('Reale Straßenroute wird berechnet …');
    const r=await getRoute(START.coord,DEST.coord); buildRoute(r);
    progress=0; traveled=0; speed=0; fuel=vehicle.tank; overview=false;
    addRouteLayers(map); addEndpoints(map); addRouteLayers(miniMap); addEndpoints(miniMap);
    queryFuelAround(START.coord,true);
    updateHud(); updateCamera(); hideLoading(); el.drawer.classList.remove('open');
  }catch(err){ showError(`${err.message||err} Es wird keine Fantasieroute als Ersatz erzeugt.`); }
}

function setVehicle(key){
  const prevPct=fuel/vehicle.tank; vehicle=vehicles[key]||vehicles.family; fuel=clamp(vehicle.tank*prevPct,0,vehicle.tank);
  el.playerCar.className=vehicle.css; el.vehicleStats.textContent=`${vehicle.ps} PS · Vmax ${vehicle.max} km/h · Tank ${vehicle.tank} l · ${vehicle.cons.toFixed(1).replace('.',',')} l/100 km`; updateHud();
  try{localStorage.setItem('edVehicle',key);}catch{}
}

function bindHold(button,on,off){ const down=e=>{e.preventDefault();button.classList.add('active');on();}; const up=e=>{e.preventDefault();button.classList.remove('active');off();}; button.addEventListener('pointerdown',down); ['pointerup','pointercancel','pointerleave'].forEach(t=>button.addEventListener(t,up)); }
bindHold(el.gasBtn,()=>gasPressed=true,()=>gasPressed=false); bindHold(el.brakeBtn,()=>brakePressed=true,()=>brakePressed=false); bindHold(el.leftBtn,()=>steer=-1,()=>{if(steer<0)steer=0;}); bindHold(el.rightBtn,()=>steer=1,()=>{if(steer>0)steer=0;});

async function enableTilt(){
  try{
    if(typeof DeviceOrientationEvent==='undefined') throw new Error('Neigungssensor ist auf diesem Gerät nicht verfügbar.');
    if(typeof DeviceOrientationEvent.requestPermission==='function'){ const p=await DeviceOrientationEvent.requestPermission(); if(p!=='granted') throw new Error('Sensorfreigabe wurde nicht erteilt.'); }
    if(!tiltEnabled) window.addEventListener('deviceorientation',ev=>{if(!tiltEnabled)return; tiltSteer=clamp((Number(ev.gamma)||0)/27,-1,1);},{passive:true});
    tiltEnabled=true; el.tiltState.textContent='Handy-Neigung: aktiv'; el.tiltBtn.textContent='📱 Lenkung aktiv';
  }catch(e){ el.tiltState.textContent=e.message||String(e); }
}

function updateTraffic(dt){
  trafficPhase += dt*(speed/80+0.25);
  const specs=[['.tc1',.54,43,18],['.tc2',.42,58,27],['.tc3',.33,49,35]];
  specs.forEach(([sel,base,left,rate],i)=>{ const n=document.querySelector(sel); const wave=((trafficPhase*rate+i*21)%16)-8; n.style.top=`${base*100+wave*.08}%`; n.style.left=`${left+Math.sin(trafficPhase*.7+i)*2}%`; });
}

function driveLoop(ts){
  const dt=Math.min(.06,(ts-lastFrame)/1000); lastFrame=ts;
  if(!paused&&route.coords.length&&!overview){
    if(gasPressed&&fuel>0){ if(speed<0) speed=Math.min(0,speed+vehicle.brake*dt); else speed+=vehicle.acc*dt; }
    else if(!brakePressed) speed*=Math.pow(.989,dt*60);
    if(brakePressed){ if(speed>1) speed-=vehicle.brake*dt; else speed-=9.5*dt; }
    speed=clamp(speed,-25,vehicle.max);
    if(fuel<=0&&speed>0) speed*=Math.pow(.45,dt*60);
    const move=speed/3.6*dt; progress=clamp(progress+move,0,route.distance); if(move>0) traveled+=move;
    if(Math.abs(move)>.001) fuel=Math.max(0,fuel-(vehicle.cons/100000)*Math.abs(move));

    const p=pointAt(progress), steering=Math.abs(tiltSteer)>.08?tiltSteer:steer;
    const lane=clamp(Math.abs(steering)*1.12,0,1.15); el.offRouteBanner.classList.toggle('hidden',lane<1.02||Math.abs(speed)<15); if(lane>1.02) speed*=Math.pow(.84,dt*3);
    const station=nearestFuel(p.coord); const tankZone=station&&station.dist<85;
    if(tankZone){ el.tankBanner.classList.remove('hidden'); if(Math.abs(speed)<5){ fuel=Math.min(vehicle.tank,fuel+vehicle.tank*.18*dt); speed*=Math.pow(.70,dt*5); el.tankBannerText.textContent=`${station.name}: Tanken ${Math.round(fuel/vehicle.tank*100)} %`; } else el.tankBannerText.textContent=`${station.name} · ${Math.round(station.dist)} m · unter 5 km/h anhalten`; } else el.tankBanner.classList.add('hidden');
    if(!station||station.dist>2500) queryFuelAround(p.coord,false);

    if(progress>=route.distance-2){speed=0;el.navInstruction.textContent='Ziel erreicht';}
    updateCamera(); updateHud(); updateTraffic(dt);
  }
  requestAnimationFrame(driveLoop);
}

function initializeMaps(){
  map=new maplibregl.Map({container:'map',style:MAP_STYLE,center:[7.63,51.10],zoom:13,pitch:78,bearing:0,antialias:true,maxPitch:85,attributionControl:true});
  miniMap=new maplibregl.Map({container:'miniMap',style:MAP_STYLE,center:[7.63,51.10],zoom:13,interactive:false,attributionControl:false});
  return Promise.all([new Promise(r=>map.on('load',r)),new Promise(r=>miniMap.on('load',r))]);
}

async function boot(){
  try{
    showLoading('3D-Karte wird geladen …'); await initializeMaps(); addTerrainAndBuildings();
    showLoading('Startadresse Löher Weg 2A wird geprüft …'); START=await geocode(START_QUERY); await wait(1100);
    const saved=(()=>{try{return localStorage.getItem('edVehicle')}catch{return null}})(); if(saved&&vehicles[saved]){el.vehicle.value=saved;setVehicle(saved);} else setVehicle('family');
    await setDestination(el.destination.value);
  }catch(e){ showError(e.message||String(e)); }
}

el.menuBtn.addEventListener('click',()=>el.drawer.classList.add('open')); el.closeDrawer.addEventListener('click',()=>el.drawer.classList.remove('open'));
el.routeBtn.addEventListener('click',()=>{const q=el.destination.value.trim();if(q)setDestination(q);}); el.destination.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();el.routeBtn.click();}});
document.querySelectorAll('.quick').forEach(b=>b.addEventListener('click',()=>{el.destination.value=b.dataset.dest;setDestination(b.dataset.dest);}));
el.vehicle.addEventListener('change',()=>setVehicle(el.vehicle.value)); el.tiltBtn.addEventListener('click',enableTilt); el.pauseBtn.addEventListener('click',()=>{paused=!paused;el.pauseBtn.textContent=paused?'▶ Weiter':'⏸ Pause';});
el.restartBtn.addEventListener('click',()=>{progress=0;traveled=0;speed=0;fuel=vehicle.tank;overview=false;updateCamera();updateHud();}); el.overviewBtn.addEventListener('click',()=>{if(overview)returnDriveView();else showOverview();el.overviewBtn.textContent=overview?'🚗 Fahransicht':'🗺 Route zeigen';});
el.retryBtn.addEventListener('click',()=>{el.errorOverlay.classList.add('hidden');setDestination(el.destination.value.trim()||'Kölner Dom, Köln');});

document.addEventListener('keydown',e=>{if(['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName))return;if(e.key==='ArrowUp'||e.key==='w')gasPressed=true;if(e.key==='ArrowDown'||e.key==='s')brakePressed=true;if(e.key==='ArrowLeft'||e.key==='a')steer=-1;if(e.key==='ArrowRight'||e.key==='d')steer=1;});
document.addEventListener('keyup',e=>{if(e.key==='ArrowUp'||e.key==='w')gasPressed=false;if(e.key==='ArrowDown'||e.key==='s')brakePressed=false;if((e.key==='ArrowLeft'||e.key==='a')&&steer<0)steer=0;if((e.key==='ArrowRight'||e.key==='d')&&steer>0)steer=0;});

setInterval(updateClock,30000); updateClock(); requestAnimationFrame(driveLoop); boot();
if('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
