/*!
 * Capsule Model Studio — app.js (based on Anime2.5DRig, MIT)
 * Editor UI: open a parts PSD, check the auto rig, try poses, tune the model,
 * export a Capsule bundle. Deformation lives in engine/core.js (shared with
 * the Capsule player), so what is shown here is what the bundle plays.
 * Classic script (no modules) so that index.html also works from file://.
 * MIT License
 */
(function(){
'use strict';
const APP_VERSION='0.2.0';
const RT=window.RigRuntime, FF=window.FaceFeatures, Core=window.CapsuleCore;
const QUERY=new URLSearchParams(location.search);
const CAMERA_MODE=QUERY.get('cam')==='1';
const $=id=>document.getElementById(id);
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
const round2=v=>Math.round(v*1000)/1000;
$('appVersion').textContent='v'+APP_VERSION;

// ---------- small helpers ----------
const statusEl=$('appStatus');let statusTimer=null;
function status(message,error=false){
  statusEl.textContent=message;statusEl.classList.toggle('error',error);statusEl.classList.remove('fade');
  clearTimeout(statusTimer);if(!error)statusTimer=setTimeout(()=>statusEl.classList.add('fade'),6000);
}
function download(blob,name){
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.style.display='none';
  document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),10000);
}
function storageGet(key){try{return localStorage.getItem(key);}catch(err){return null;}}
function storageSet(key,value){localStorage.setItem(key,value);}
function baseFileName(){return RT.safeFileName(modelName,'model');}

// ---------- WebGL ----------
const cv=$('cv');
const gl=cv.getContext('webgl',{alpha:true,antialias:true,premultipliedAlpha:true,preserveDrawingBuffer:false});
if(!gl){$('dropStatus').textContent='이 브라우저에서는 WebGL을 쓸 수 없습니다. 하드웨어 가속을 켜 주세요.';return;}
let renderer;
try{renderer=window.RigRenderer.create(gl);}catch(err){$('dropStatus').textContent='그리기를 시작하지 못했습니다: '+err.message;return;}

// ---------- model state (rebuilt per PSD) ----------
let modelId='',modelName='',currentRig=null,background='checker',paused=false,contextLost=false,lastFrame=null,dirty=true;
let model=null;   // Core model: meshes, anchors, spring state
let layers=[],A=null,anchorOffsets={},CW=768,CH=768,FS=1,NP=null,CHEST=null,hasEyeClose2=false;
let lastPre=null,anchorMode=false,anchorPreview=null,highlightLayer=null;
function invalidate(){dirty=true;}
// Layer order is edited in place or replaced; the engine must draw the same list.
function setLayers(list){layers=list;if(model)model.layers=list;}

function makeThumb(img){
  try{
    const s=Math.min(1,64/Math.max(img.width,img.height)),tw=Math.max(1,Math.round(img.width*s)),th=Math.max(1,Math.round(img.height*s));
    const full=document.createElement('canvas');full.width=img.width;full.height=img.height;full.getContext('2d').putImageData(img,0,0);
    const t=document.createElement('canvas');t.width=tw;t.height=th;const ctx=t.getContext('2d');ctx.imageSmoothingQuality='high';ctx.drawImage(full,0,0,tw,th);
    return t.toDataURL('image/png');
  }catch(err){return '';}
}
// Build the engine model (meshes, strand weights) and upload every part to the GPU.
function prepareModel(rig){
  const maxTexture=gl.getParameter(gl.MAX_TEXTURE_SIZE),maxViewport=gl.getParameter(gl.MAX_VIEWPORT_DIMS);
  if(rig.canvas.w>maxViewport[0]||rig.canvas.h>maxViewport[1]||rig.canvas.w>maxTexture||rig.canvas.h>maxTexture)throw new Error('이 컴퓨터가 그릴 수 있는 크기('+Math.min(maxViewport[0],maxTexture)+'px)를 넘습니다. PSD를 줄여 주세요');
  for(const Lr of rig.layers)if(Lr.w>maxTexture||Lr.h>maxTexture)throw new Error('파츠 이미지가 이 컴퓨터의 한도 '+maxTexture+'px를 넘습니다');
  const M=Core.createModel(rig,{anchorOffsets:{}}),uploaded=[];
  try{
    M.layers.forEach((L,i)=>{
      const Lr=rig.layers[i];
      const image=(typeof ImageData!=='undefined')?new ImageData(Lr.img.data,Lr.img.width,Lr.img.height):Lr.img;
      L.thumb=makeThumb(image);
      renderer.upload(L,{positions:L.cur,uvs:L.uv,indices:L.indices,image});uploaded.push(L);
    });
    return M;
  }catch(err){uploaded.forEach(renderer.dispose);throw err;}
}
function applyAnchors(){
  if(!model)return;
  model.anchorOffsets=anchorOffsets;Core.applyAnchors(model);
  A=model.A;FS=model.FS;NP=model.NP;CHEST=model.CHEST;
  const n=Object.keys(anchorOffsets).length;
  $('anchorSummary').textContent=n?n+'곳을 직접 맞췄습니다':'모두 자동 위치입니다';
  renderOverlay();invalidate();
}
function applyRig(rig){
  if(contextLost)throw new Error('그리기가 복구된 뒤에 다시 열어 주세요');
  const prepared=prepareModel(rig);
  layers.forEach(renderer.dispose);model=prepared;setLayers(prepared.layers);currentRig=rig;
  CW=rig.canvas.w;CH=rig.canvas.h;
  anchorOffsets={};
  applyAnchors();
  lastFrame=null;blinkT=-1;blinkVariant=1;irisBounceT=-1;
  hasEyeClose2=layers.some(L=>L.bn==='eye_close2');maskFailed=false;
  cv.width=CW;cv.height=CH;
  $('overlay').setAttribute('viewBox','0 0 '+CW+' '+CH);
  resetView();fit();
  expandedLayers.clear();renderLayerList();renderDiagnostics(rig);
  $('drop').classList.add('hidden');document.body.classList.remove('welcome');
  document.querySelectorAll('[data-model-action]').forEach(b=>b.disabled=false);
  invalidate();
}

// ---------- PSD loading ----------
const dropEl=$('drop'),dropStatus=$('dropStatus');
let loadTicket=0,loaderWorker=null,loadController=null,cancelWorker=null,lastPsdBuffer=null;
function setLoading(on){$('btnCancelLoad').hidden=!on;$('loadProgress').hidden=!on;}
function cancelLoad(){
  loadTicket++;loadController?.abort();loadController=null;
  loaderWorker?.terminate();loaderWorker=null;
  cancelWorker?.(new DOMException('중지','AbortError'));cancelWorker=null;
  setLoading(false);
  dropEl.classList.toggle('hidden',!!layers.length);dropStatus.textContent='';
}
function loadProgress(message){dropStatus.textContent=message;status(message);}
async function parseModel(buffer,generic,ticket){
  if(location.protocol!=='file:'&&typeof Worker!=='undefined'){
    return new Promise((resolve,reject)=>{
      cancelWorker=reject;loaderWorker=new Worker('lib/psd-worker.js');
      loaderWorker.onmessage=ev=>{
        if(ticket!==loadTicket)return;
        if(ev.data.progress){loadProgress(ev.data.progress);return;}
        loaderWorker.terminate();loaderWorker=null;cancelWorker=null;
        if(ev.data.error)reject(new Error(ev.data.error));else resolve(ev.data);
      };
      loaderWorker.onerror=ev=>{ev.preventDefault?.();loaderWorker?.terminate();loaderWorker=null;cancelWorker=null;reject(new Error('PSD 분석을 시작하지 못했습니다 (메모리 부족일 수 있음). localhost로 열거나 PSD를 줄여 주세요'));};
      loaderWorker.postMessage({buffer,generic},[buffer]);
    });
  }
  // Opening index.html directly cannot reliably start a worker; keep that path usable.
  await new Promise(r=>setTimeout(r,20));
  if(ticket!==loadTicket)throw new DOMException('중지','AbortError');
  const id=RT.fingerprint(buffer);
  const options={useImageData:true,skipThumbnail:true,skipCompositeImageData:true};
  Rigger.validatePsd(agPsd.readPsd(new Uint8Array(buffer),{...options,skipLayerImageData:true}));
  const psd=agPsd.readPsd(new Uint8Array(buffer),{...options,skipCompositeImageData:false}),pre=Rigger.cleanPsdLayers(psd);
  return {psd,pre,rig:Rigger.buildRig(psd,{generic}),id};
}
/** source(signal) resolves to an ArrayBuffer. */
async function loadModel(source,name){
  cancelLoad();const ticket=loadTicket;
  loadController=new AbortController();const signal=loadController.signal;
  setLoading(true);
  dropEl.classList.remove('hidden');loadProgress(name+' 여는 중…');
  try{
    if(!window.agPsd||!window.Rigger)throw new Error('lib 폴더의 파일을 읽지 못했습니다. npm start로 연 주소(http://127.0.0.1:8000/)에서 열어 주세요');
    const buf=await source(signal);
    RT.validateHeader(buf);
    lastPsdBuffer=buf.slice(0);   // the worker takes ownership of buf; 「표정 그림 만들기」 needs the PSD again
    await customGenericReady;await defaultReactionsReady.catch(()=>{});
    if(ticket!==loadTicket)return;
    const parsed=await parseModel(buf,genericOpts().generic,ticket);
    if(ticket!==loadTicket)return;
    setAnchorMode(false);
    applyRig(parsed.rig);
    modelId=parsed.id||'';modelName=name;lastPre=parsed.pre;
    $('modelName').textContent=name;$('modelName').title=name;
    document.title=name+' — Capsule Model Studio';
    resetParams();loadReactions();
    const hadSettings=restoreSettings();
    // skin eyelids are the default way to close the eyes, unless this model's saved tuning says otherwise
    if(model.hasLid){let saved=null;try{saved=JSON.parse(storageGet('anime25d.settings.'+modelId)||'null');}catch(err){}
      if(!hadSettings||!saved||!saved.params||saved.params.eyeLid===undefined)setSlider('eyeLid',1);}
    history.reset(historySnapshot());updateHistoryButtons();
    if(parsed.pre.noisy>0)$('rigInfo').textContent+='\n잡티 정리: '+parsed.pre.noisy+'/'+parsed.pre.layers+' 레이어';
    dropStatus.textContent='';
    selectTab('check');
    status(name+' 을(를) 열었습니다');
  }catch(err){
    if(ticket!==loadTicket||err.name==='AbortError')return;
    dropStatus.textContent='오류: '+err.message;status(dropStatus.textContent,true);
    dropEl.classList.toggle('hidden',!!layers.length);
  }finally{
    if(ticket===loadTicket){setLoading(false);loadController=null;}
  }
}
$('btnCancelLoad').addEventListener('click',()=>{cancelLoad();status('불러오기를 중지했습니다');});
// Optional generic closed-eye / closed-mouth parts next to index.html (eye_close.psd, mouth_close.psd).
let customGeneric=null;
async function loadCustomGeneric(){
  if(typeof fetch==='undefined'||!window.agPsd||!window.Rigger||location.protocol==='file:')return;
  async function grab(url){
    try{
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
      let buffer;
      try{const r=await fetch(url,{signal:controller.signal});if(!r.ok)return null;buffer=await r.arrayBuffer();}finally{clearTimeout(timer);}
      RT.validateHeader(buffer);
      const psd=window.agPsd.readPsd(new Uint8Array(buffer),{useImageData:true,skipThumbnail:true,skipCompositeImageData:true});
      return window.Rigger.flattenPsdToImg(psd);
    }catch(err){return null;}
  }
  const [eye,mouth]=await Promise.all([grab('eye_close.psd'),grab('mouth_close.psd')]);
  const g={};
  if(eye){const s=window.Rigger.splitImgLR(eye);if(s){g.eyeL=s.l;g.eyeR=s.r;}}
  if(mouth)g.mouth=mouth;
  if(g.eyeL||g.mouth)customGeneric=g;
}
const customGenericReady=loadCustomGeneric();
function genericOpts(){
  const GP=window.GenericParts;
  const base=GP?{eyeL:GP.get('eyeL'),eyeR:GP.get('eyeR'),mouth:GP.get('mouth')}:{};
  const g=Object.assign({},base,customGeneric||{});
  return (g.eyeL||g.mouth)?{generic:g}:{};
}
function loadFile(f){
  return loadModel(async()=>{
    if(!/\.psd$/i.test(f.name))throw new Error('.psd 파일을 골라 주세요');
    if(f.size>RT.MAX_FILE_BYTES)throw new Error('PSD는 128MB 이하만 열 수 있습니다');
    return f.arrayBuffer();
  },f.name);
}
function openFile(f){
  if(/\.json$/i.test(f.name))importSettingsFile(f);
  else if(window.SeeThrough&&SeeThrough.isImage(f))convertImage(f);
  else loadFile(f);
}
$('btnFile').addEventListener('click',()=>$('fileInput').click());
// 「새 캐릭터」: back to the upload card (✕ returns to the open model)
function showStart(){dropEl.classList.remove('hidden');$('dropClose').hidden=!layers.length;dropStatus.textContent='';findLocalServer();}
$('btnOpen').addEventListener('click',showStart);
$('dropClose').addEventListener('click',()=>{if(layers.length&&!stController){dropEl.classList.add('hidden');}});
$('fileInput').addEventListener('change',ev=>{const f=ev.target.files[0];ev.target.value='';if(f)openFile(f);});
function fetchSource(path){
  return async signal=>{
    const r=await fetch(path,{signal});
    if(!r.ok)throw new Error(path+' 을(를) 찾을 수 없습니다 (HTTP '+r.status+')');
    if(Number(r.headers.get('Content-Length'))>RT.MAX_FILE_BYTES)throw new Error('PSD는 128MB 이하만 열 수 있습니다');
    return r.arrayBuffer();
  };
}
const SAMPLE_FILES={A:'sample2.psd',B:'sample.psd'};
function loadSample(key){const filename=SAMPLE_FILES[key];if(filename)return loadModel(fetchSource(filename),filename);}
document.querySelectorAll('[data-sample]').forEach(button=>button.addEventListener('click',()=>loadSample(button.dataset.sample)));
// Drag & drop anywhere: PSD opens a model, a picture goes to see-through, JSON imports settings.
let dragDepth=0;
const hasFiles=e=>!!e.dataTransfer&&[...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter',e=>{if(!hasFiles(e))return;e.preventDefault();dragDepth++;$('stage').classList.add('dragover');});
window.addEventListener('dragover',e=>{if(!hasFiles(e))return;e.preventDefault();e.dataTransfer.dropEffect='copy';});
window.addEventListener('dragleave',e=>{if(!hasFiles(e))return;dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)$('stage').classList.remove('dragover');});
window.addEventListener('drop',e=>{
  e.preventDefault();dragDepth=0;$('stage').classList.remove('dragover');
  const f=hasFiles(e)&&e.dataTransfer.files[0];if(f)openFile(f);
});

// ---------- see-through: picture -> parts PSD -> rig ----------
// serve.py looks after the conversion server on this PC (seethrough/manager.py): it starts it when
// see-through is installed and installs it when 「설치하기」 is pressed. The start card shows one of:
// ready (upload a picture), install, colab (no NVIDIA GPU), checking.
let stController=null,stLast=null,stLocal=null,stSetupInfo=null,stPoll=null,stPending=null;
const ST_BUSY=['checking','installing','starting'];
function stConn(){return stLocal?{url:stLocal.url,token:''}:null;}
const gpuName=g=>g?g.name.replace(/^NVIDIA (GeForce )?/,'')+' '+Math.round(g.vram_mb/1024)+'GB':'GPU';
async function findLocalServer(){
  let cfg=null;
  if(location.protocol!=='file:'&&typeof fetch!=='undefined'){
    try{const r=await fetch('local-config.json',{cache:'no-store'});if(r.ok)cfg=await r.json();}catch(err){cfg=null;}
  }
  stLocal=cfg&&cfg.seethrough||null;stSetupInfo=cfg&&cfg.setup||null;redrawInfo=cfg&&cfg.redraw||null;
  renderUploadCard();renderRedrawOpt();
  clearTimeout(stPoll);
  if(!stLocal&&stSetupInfo&&ST_BUSY.includes(stSetupInfo.state))stPoll=setTimeout(findLocalServer,2000);
  if(stLocal&&stPending){const f=stPending;stPending=null;convertImage(f);}   // a picture dropped while it was getting ready
  return stLocal;
}
function renderUploadCard(){
  const S=stSetupInfo,card=$('upload'),foot=$('stLocal'),log=$('stSetupLog');
  let mode='colab';
  if(stLocal)mode='ready';
  else if(S&&S.state==='checking')mode='checking';
  else if(S&&S.state!=='no-gpu')mode='install';
  card.dataset.mode=mode;
  foot.textContent='';
  if(mode==='ready')foot.textContent='● 이 PC의 GPU로 변환합니다 ('+gpuName(stLocal.gpu)+')';
  if(mode==='install'){
    const st=S.state,btn=$('btnStInstall');
    $('installTitle').textContent=st==='installing'?'설치하는 중입니다':st==='starting'?'변환 도구를 켜는 중입니다':st==='error'?'문제가 생겼습니다':'처음 한 번, 그림을 PSD로 바꾸는 도구를 설치합니다';
    $('installMeta').textContent=st==='installing'?(S.message||'준비 중')+' · 10~20분 걸립니다. 창을 닫아도 계속됩니다':
      st==='error'?(S.message||''):st==='starting'?'잠시만 기다려 주세요':'이 PC의 '+gpuName(S.gpu)+'로 변환합니다 · 10~20분, 약 10GB';
    btn.hidden=st==='installing'||st==='starting';btn.textContent=st==='error'?'다시 시도':'설치하기';
    $('stSetupBar').hidden=!ST_BUSY.includes(st);
    log.hidden=!(S.log&&S.log.length);log.textContent=(S.log||[]).join('\n');
  }
}
$('btnStInstall').addEventListener('click',async()=>{
  const btn=$('btnStInstall');btn.disabled=true;
  try{
    const r=await fetch('api/seethrough/install',{method:'POST'});const j=await r.json().catch(()=>({}));
    if(!r.ok&&!(j.setup&&ST_BUSY.includes(j.setup.state)))throw new Error((j.setup&&j.setup.message)||('HTTP '+r.status));
    status('설치를 시작했습니다 (10~20분)'+(stPending?'. 끝나면 '+stPending.name+'을(를) 바로 변환합니다':''));
  }catch(err){status('설치를 시작하지 못했습니다: '+err.message,true);}
  finally{btn.disabled=false;findLocalServer();}
});
findLocalServer();
$('btnImage').addEventListener('click',()=>$('fileInput').click());
// 변환 품질: 1280 (default, sharper face, ~20 min on an 8 GB GPU) or 1024 (~8 min). Measured 2026-11-14 on an RTX 4060.
const QUALITY_PREF='capsule.quality';
{const q=storageGet(QUALITY_PREF);const el=document.querySelector('input[name="stQuality"][value="'+q+'"]');if(el)el.checked=true;}
document.querySelectorAll('input[name="stQuality"]').forEach(el=>el.addEventListener('change',()=>{try{storageSet(QUALITY_PREF,el.value);}catch(err){}}));
const stQuality=()=>Number((document.querySelector('input[name="stQuality"]:checked')||{}).value)||1280;

// 「AI로 자세 바로잡기」: OpenAI redraws the picture (upright, both arms visible) before conversion.
// serve.py keeps the API key on this PC (seethrough/redraw.py); the page only sees its last 4 characters.
let redrawInfo=null;
const REDRAW_PREF='capsule.redraw';
try{$('optRedraw').checked=storageGet(REDRAW_PREF)==='1';}catch(err){}
function renderRedrawOpt(){
  const on=$('optRedraw').checked||$('optExprArt').checked||$('optPoseArt').checked,ready=!!(redrawInfo&&redrawInfo.ready);
  $('keyRow').hidden=!on||ready;
  $('keySaved').hidden=!on||!ready;
  if(ready){$('keySaved').replaceChildren('OpenAI 키 '+redrawInfo.hint+' 저장됨 · ');const b=document.createElement('button');b.type='button';b.className='link';b.textContent='바꾸기';
    b.addEventListener('click',()=>{$('keyRow').hidden=false;$('openaiKey').focus();});$('keySaved').append(b);}
}
$('optRedraw').addEventListener('change',()=>{try{storageSet(REDRAW_PREF,$('optRedraw').checked?'1':'0');}catch(err){}renderRedrawOpt();});
const EXPR_ART_PREF='capsule.exprArt';
try{$('optExprArt').checked=storageGet(EXPR_ART_PREF)==='1';}catch(err){}
$('optExprArt').addEventListener('change',()=>{try{storageSet(EXPR_ART_PREF,$('optExprArt').checked?'1':'0');}catch(err){}renderRedrawOpt();});
// 「표정 그림 만들기」: serve.py runs seethrough/expression_art.py (5 OpenAI edits) and returns the PSD with
// closed / smiling eyes and mouth shapes added as layers.
async function expressionArt(psd,signal){
  const r=await fetch('api/expression-art',{method:'POST',body:psd,signal});
  if(!r.ok){const j=await r.json().catch(()=>({}));throw new Error(j.error||('HTTP '+r.status));}
  let info=null;try{info=JSON.parse(r.headers.get('X-Expression-Art')||'null');}catch(err){}
  return {psd:await r.arrayBuffer(),info};
}
// 「공부 자세 그림 만들기」: for each pose GPT draws the character in that pose with props (serve.py
// /api/pose-image), see-through splits it (same framing: no picture cleanup), and serve.py adds its arms
// and props to the PSD as "handwear@pose" / "objects@pose" (/api/pose-merge). The engine shows them with
// poseTyping / poseWriting / poseWave.
const POSE_ART=[['typing','키보드 치기'],['writing','필기'],['wave','손 흔들기']];
const POSE_ART_PREF='capsule.poseArt';
try{$('optPoseArt').checked=storageGet(POSE_ART_PREF)==='1';}catch(err){}
$('optPoseArt').addEventListener('change',()=>{try{storageSet(POSE_ART_PREF,$('optPoseArt').checked?'1':'0');}catch(err){}renderRedrawOpt();});
async function poseArt(psd,conn,signal,progress){
  let base=psd;const done=[],failed=[];
  for(const [i,[pose,label]] of POSE_ART.entries()){
    const tag='공부 자세 '+(i+1)+'/'+POSE_ART.length+' · '+label;
    try{
      const at=(f,log)=>({overall:(i+f)/POSE_ART.length,log:[tag].concat(log||[])});
      progress(tag+' — GPT가 그리는 중 (1~2분)',at(0.02));
      let r=await fetch('api/pose-image?pose='+pose,{method:'POST',body:base.slice(0),signal});
      if(!r.ok){const j=await r.json().catch(()=>({}));throw new Error(j.error||('HTTP '+r.status));}
      const png=new File([await r.blob()],'pose_'+pose+'.png',{type:'image/png'});
      progress(tag+' — 팔 · 소품 나누는 중 (약 4분)',at(0.1));
      // arms and props only: see-through's body pass (seethrough/body_only.py), half the time
      const v=await SeeThrough.convert(conn,png,{signal,resolution:1024,prepare:false,parts:'body',onStatus:(job,text)=>{
        const f=job.phase==='parts'?0.1+0.75*(job.percent||0)/100:job.phase==='depth'||job.phase==='psd'?0.9:0.1;
        progress(tag+' — '+(STAGE_TEXT[job.phase]||text||'파츠로 나누는 중'),at(Math.min(0.95,f),job.log));}});
      progress(tag+' — 모델에 합치는 중',at(0.97));
      const body=new Uint8Array(base.byteLength+v.psd.byteLength);body.set(new Uint8Array(base),0);body.set(new Uint8Array(v.psd),base.byteLength);
      r=await fetch('api/pose-merge?pose='+pose,{method:'POST',body,headers:{'X-Base-Length':String(base.byteLength)},signal});
      if(!r.ok){const j=await r.json().catch(()=>({}));throw new Error(j.error||('HTTP '+r.status));}
      base=await r.arrayBuffer();done.push(label);
    }catch(err){if(err.name==='AbortError')throw err;failed.push(label+': '+err.message);}
  }
  return {psd:base,done,failed};
}
$('btnPoseArt').addEventListener('click',async()=>{
  if(!lastPsdBuffer||!layers.length)return;
  if(!(redrawInfo&&redrawInfo.ready)){status('OpenAI 키가 필요합니다. 「새 캐릭터」 화면의 「AI로 자세 바로잡기」 아래에 넣어 주세요',true);return;}
  const conn=stConn()||(await findLocalServer(),stConn());
  if(!conn){status('이 PC의 변환 서버가 필요합니다 (시작 화면 확인)',true);return;}
  const btn=$('btnPoseArt');btn.disabled=true;const name=modelName.replace(/(\.psd)?$/i,'');
  try{
    const r=await poseArt(lastPsdBuffer.slice(0),conn,undefined,t=>status(t));
    if(!r.done.length)throw new Error(r.failed.join(' / ')||'만들지 못했습니다');
    await loadModel(async()=>r.psd,name.replace(/_자세$/,'')+'_자세.psd');
    status('공부 자세를 넣었습니다: '+r.done.join(', ')+(r.failed.length?' · 실패: '+r.failed.join(' / '):''),!!r.failed.length);
  }catch(err){status('공부 자세 그림을 만들지 못했습니다: '+err.message,true);}
  finally{btn.disabled=!layers.length;}
});
const artSummary=info=>{if(!info)return '';const n=Object.keys(info.made||{}).length,f=Object.keys(info.failed||{});return n+'장 그림'+(f.length?' · 실패 '+f.join(', '):'');};
$('btnExprArt').addEventListener('click',async()=>{
  if(!lastPsdBuffer||!layers.length)return;
  if(!(redrawInfo&&redrawInfo.ready)){status('OpenAI 키가 필요합니다. 「새 캐릭터」 화면의 「AI로 자세 바로잡기」 아래에 넣어 주세요',true);return;}
  const btn=$('btnExprArt');btn.disabled=true;const name=modelName.replace(/(\.psd)?$/i,'');
  status('표정 그림을 그리는 중입니다 (GPT 5장, 몇 분 걸립니다)…');
  try{const r=await expressionArt(lastPsdBuffer.slice(0));await loadModel(async()=>r.psd,name.replace(/_표정$/,'')+'_표정.psd');status('표정 그림을 넣었습니다: '+artSummary(r.info));}
  catch(err){status('표정 그림을 만들지 못했습니다: '+err.message,true);}
  finally{btn.disabled=!layers.length;}
});
$('btnSaveKey').addEventListener('click',async()=>{
  try{
    const r=await fetch('api/redraw/key',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:$('openaiKey').value})});
    const j=await r.json();if(!r.ok)throw new Error(j.error||('HTTP '+r.status));
    redrawInfo=j;$('openaiKey').value='';renderRedrawOpt();status(j.ready?'OpenAI 키를 이 PC에 저장했습니다':'OpenAI 키를 지웠습니다');
  }catch(err){status('키를 저장하지 못했습니다: '+err.message,true);}
});
// Redraw and carry straight on with the redrawn picture (no question to the user); if the redraw
// fails, carry on with the original and say so. Resolves to the File to convert.
async function redrawStep(f,ctl,t0){
  const prep=$('stPicPrep'),cap=$('stPicPrepCap');
  prep.hidden=true;prep.removeAttribute('src');$('stPicPrepWait').hidden=false;$('stPicPrepWait').textContent='다시 그리는 중… (1~2분)';
  cap.textContent='AI가 다시 그린 그림';
  stShowJob({status:'running',phase:'redraw'},'AI가 정면 · 양팔 자세로 다시 그리는 중',t0,null);
  let blob=null;
  try{
    const r=await fetch('api/redraw',{method:'POST',body:f,signal:ctl.signal});
    if(!r.ok){const j=await r.json().catch(()=>({}));throw new Error(j.error||('HTTP '+r.status));}
    blob=await r.blob();
  }catch(err){
    if(err.name==='AbortError')throw err;
    status('자세 바로잡기를 못 해서 원본으로 계속합니다: '+err.message,true);
  }
  cap.textContent='배경을 지우고 다듬은 그림';$('stPicPrepWait').textContent='다듬는 중…';
  if(!blob)return f;
  const out=new File([blob],f.name.replace(/\.[^.]+$/,'')+'_redrawn.png',{type:'image/png'});
  $('stPicOrig').src=URL.createObjectURL(out);$('stPicOrigCap').textContent='AI가 다시 그린 그림';
  return out;
}
// stop needs two clicks (a stray click must not kill a 20-minute job)
let stCancelArmed=0;
$('stCancel').addEventListener('click',()=>{
  const b=$('stCancel');
  if(Date.now()-stCancelArmed<4000){stCancelArmed=0;b.textContent='중지';b.classList.remove('armed');if(stController)stController.abort();return;}
  stCancelArmed=Date.now();b.textContent='한 번 더 누르면 중지';b.classList.add('armed');
  setTimeout(()=>{if(Date.now()-stCancelArmed>=3900){b.textContent='중지';b.classList.remove('armed');}},4000);
});
$('btnSaveConverted').addEventListener('click',()=>{if(stLast)download(new Blob([stLast.psd],{type:'application/octet-stream'}),stLast.name+'.psd');});
// Ctrl+V a picture on the start screen
document.addEventListener('paste',e=>{
  if(layers.length&&dropEl.classList.contains('hidden'))return;
  const item=[...(e.clipboardData?e.clipboardData.items:[])].find(i=>i.kind==='file'&&/^image\/(png|jpeg|webp)$/.test(i.type));
  if(!item)return;
  e.preventDefault();const blob=item.getAsFile(),ext=item.type.split('/')[1].replace('jpeg','jpg');
  convertImage(new File([blob],'pasted.'+ext,{type:item.type}));
});
const mmss=s=>Math.floor(s/60)+':'+String(s%60).padStart(2,'0');
const PHASES=['redraw','prepare','parts','depth','expr','pose','rig'];
function stShowJob(job,text,t0,conn){
  $('stJob').hidden=false;$('welcome').hidden=true;
  $('stJobStage').textContent=text||'';
  $('stJobTime').textContent=mmss(Math.round((performance.now()-t0)/1000));
  const phase=job.status==='done'?'rig':(job.phase==='psd'?'depth':job.phase||'prepare'),at=PHASES.indexOf(phase);
  document.querySelectorAll('#stSteps li').forEach((li,i)=>{li.classList.toggle('done',i<at);li.classList.toggle('now',i===at);});
  const pct=job.status==='done'?100:job.phase==='pose'&&job.overall!=null?job.overall*100:job.phase==='expr'||job.phase==='pose'?99:job.phase==='redraw'?1:job.phase==='parts'?5+0.75*(job.percent||0):job.phase==='depth'?80+0.18*(job.percent||0):job.phase==='psd'?98:2;
  $('stJobBar').style.width=Math.min(99,pct).toFixed(1)+'%';
  {const logEl=$('stJobLog'),atEnd=logEl.scrollTop+logEl.clientHeight>=logEl.scrollHeight-4;   // follow new lines unless scrolled up to read
   logEl.textContent=(job.log||[]).slice(-40).join('\n');if(atEnd)logEl.scrollTop=logEl.scrollHeight;}
  if(job.has_prepared&&conn&&job.id&&$('stPicPrep').hidden&&!$('stPicPrep').getAttribute('src')){
    const img=$('stPicPrep');img.onload=()=>{img.hidden=false;$('stPicPrepWait').hidden=true;};img.src=conn.url+'/jobs/'+job.id+'/prepared';
  }
}
function stHideJob(){$('stJob').hidden=true;$('welcome').hidden=false;}
const STAGE_TEXT={queued:'차례를 기다리는 중',prepare:'그림 다듬는 중 (배경 지우기)',parts:'파츠 나누는 중',depth:'앞뒤 깊이 계산 중',psd:'PSD 정리 중 (가려진 부분 바로잡기)',done:'완료'};
async function convertImage(f){
  let conn=stConn();
  dropEl.classList.remove('hidden');
  if(!conn){await findLocalServer();conn=stConn();}   // the server may have started after this page
  if(!conn){
    const st=stSetupInfo&&stSetupInfo.state;
    if(st&&st!=='no-gpu'){
      // GPU PC: keep the picture and convert it as soon as the tool is ready
      stPending=f;
      dropStatus.textContent=ST_BUSY.includes(st)?f.name+' — 준비가 끝나면 바로 PSD로 바꿔 리깅합니다':f.name+' — 「'+$('btnStInstall').textContent+'」을 누르면, 준비가 끝나는 대로 이 그림을 PSD로 바꿔 리깅합니다';
      status(ST_BUSY.includes(st)?'변환 도구 준비 중 · 끝나면 자동으로 변환합니다':'처음 한 번 변환 도구 설치가 필요합니다',!ST_BUSY.includes(st));return;
    }
    dropStatus.textContent=f.name+' 은(는) 그림입니다. 이 PC에는 NVIDIA GPU가 없어 바로 바꿀 수 없습니다. 위 안내대로 Colab에서 PSD로 바꾼 뒤 받은 PSD를 놓으세요';
    status('그림은 Colab에서 PSD로 바꿔 주세요',true);return;
  }
  if(stController)stController.abort();
  const ctl=stController=new AbortController(),t0=performance.now();
  const tick=setInterval(()=>{$('stJobTime').textContent=mmss(Math.round((performance.now()-t0)/1000));},1000);
  const orig=$('stPicOrig');if(orig.src.startsWith('blob:'))URL.revokeObjectURL(orig.src);orig.src=URL.createObjectURL(f);
  $('stPicPrep').hidden=true;$('stPicPrep').removeAttribute('src');$('stPicPrepWait').hidden=false;
  $('stJobLog').textContent='';$('stJobBar').style.width='0%';dropStatus.textContent='';
  const useRedraw=$('optRedraw').checked&&!!(redrawInfo&&redrawInfo.ready);
  if($('optRedraw').checked&&!useRedraw)status('OpenAI 키가 없어 자세 바로잡기 없이 변환합니다 (그림 올리기 아래에 키를 넣어 주세요)',true);
  document.querySelector('#stSteps li[data-phase="redraw"]').hidden=!useRedraw;$('stPicOrigCap').textContent='올린 그림';
  const useArt=$('optExprArt').checked&&!!(redrawInfo&&redrawInfo.ready);
  document.querySelector('#stSteps li[data-phase="expr"]').hidden=!useArt;
  const usePose=$('optPoseArt').checked&&!!(redrawInfo&&redrawInfo.ready);
  document.querySelector('#stSteps li[data-phase="pose"]').hidden=!usePose;
  try{
    if(useRedraw)f=await redrawStep(f,ctl,t0);
    stShowJob({status:'uploading',phase:'prepare'},'그림 올리는 중',t0,conn);
    status('그림을 PSD로 바꾸는 중: '+f.name);
    const res=stQuality();$('stEta').textContent='한 장에 보통 '+(res<=1024?'8':'20')+'분 걸립니다. 다른 일을 해도 됩니다.';
    const r=await SeeThrough.convert(conn,f,{signal:ctl.signal,resolution:res,onStatus:(job,text)=>stShowJob(job,STAGE_TEXT[job.phase]||text,t0,conn)});
    if(useArt){
      stShowJob(Object.assign({},r.job,{status:'running',phase:'expr',log:['표정 그림: 감은 눈 · 웃는 눈 · 아 입 · 웃는 입 · 오 입을 GPT가 차례로 그리는 중 (2~5분)']}),'표정 그리는 중 (GPT 5장 · 2~5분)',t0,conn);
      try{const a=await expressionArt(r.psd.slice(0),ctl.signal);r.psd=a.psd;status('표정 그림: '+artSummary(a.info));}
      catch(err){if(err.name==='AbortError')throw err;status('표정 그림 없이 계속합니다: '+err.message,true);}
    }
    if(usePose){
      const p=await poseArt(r.psd,conn,ctl.signal,(t,x)=>stShowJob(Object.assign({},r.job,{status:'running',phase:'pose'},x||{}),t,t0,conn));
      r.psd=p.psd;if(p.failed.length)status('공부 자세 일부 실패: '+p.failed.join(' / '),true);
    }
    stLast=r;$('btnSaveConverted').hidden=false;
    stShowJob(Object.assign({},r.job,{status:'done'}),'리깅하는 중',t0,conn);
    status('PSD 변환 완료 ('+mmss(Math.round((performance.now()-t0)/1000))+') — 리깅합니다');
    await loadModel(async()=>r.psd,r.name+'.psd');
    stHideJob();
  }catch(err){
    stHideJob();
    const msg=err.name==='AbortError'?'변환을 중지했습니다':err.message;
    dropStatus.textContent=msg;status(msg,err.name!=='AbortError');
  }finally{clearInterval(tick);if(stController===ctl)stController=null;}
}

// ---------- tabs ----------
function selectTab(name){
  document.querySelectorAll('#panel .tab').forEach(t=>{const on=t.dataset.tab===name;t.setAttribute('aria-selected',String(on));t.tabIndex=on?0:-1;});
  document.querySelectorAll('#panel .pane').forEach(p=>p.hidden=p.dataset.pane!==name);
}
document.querySelectorAll('#panel .tab').forEach((t,i,all)=>{
  t.addEventListener('click',()=>selectTab(t.dataset.tab));
  t.addEventListener('keydown',e=>{
    const d=e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0;if(!d)return;
    e.preventDefault();const n=all[(i+d+all.length)%all.length];selectTab(n.dataset.tab);n.focus();
  });
});
selectTab('check');

// ---------- parameters ----------
// [group, key, label, step]. Pose groups (움직여 보기) are preview only; tuning groups (모델 조정)
// are baked into the bundle (engine/bundle.js POSE_KEYS decides which is which).
const SLIDERS=[
  ['head','angleX','좌우 돌리기',.01],['head','angleY','위아래 보기',.01],['head','angleZ','고개 기울이기',.01],['head','body','몸 기울이기',.01],
  ['face','eyeOpenL','왼눈 뜨기',.01],['face','eyeOpenR','오른눈 뜨기',.01],['face','eyeSmile','눈웃음',.01],['face','eyeX','시선 좌우',.01],['face','eyeY','시선 위아래',.01],
  ['face','mouthOpen','입 벌리기',.01],['face','mouthForm','벌린 입 모양',.01],['face','mouthCForm','다문 입 모양',.01],['face','mouthWide','입 너비 (+넓게 −작게)',.01],
  ['face','brow','눈썹 높이',.01],['face','browAngSym','눈썹 각도 (+화남 −걱정)',.01],
  ['face-more','browAngL','왼눈썹 각도',.01],['face-more','browAngR','오른눈썹 각도',.01],
  ['face-more','mouthTri','세모 입 (+▽ −△)',.01],['face-more','cheekPuff','볼 부풀리기',.01],
  ['fx','fxBlush','홍조',.01],['fx','fxSweat','땀',.01],['fx','fxTears','눈물',.01],['fx','fxAnger','화남 표시',.01],['fx','fxGloom','그늘',.01],
  ['face-more','bangL','앞머리 왼쪽 넘기기',.01],['face-more','bangC','앞머리 가운데 넘기기',.01],['face-more','bangR','앞머리 오른쪽 넘기기',.01],
  ['arms','armLShoulder','왼팔 어깨 (°)',1],['arms','armLElbow','왼팔 팔꿈치 (°)',1],['arms','armRShoulder','오른팔 어깨 (°)',1],['arms','armRElbow','오른팔 팔꿈치 (°)',1],
  ['arms','armLX','왼손목 바깥',.01],['arms','armLY','왼손목 위',.01],['arms','armRX','오른손목 바깥',.01],['arms','armRY','오른손목 위',.01],
  ['arms','poseTyping','자세: 키보드 치기',.01],['arms','poseWriting','자세: 필기',.01],['arms','poseWave','자세: 손 흔들기',.01],['arms','poseSwing','손 흔들기 스윙',.01],
  ['arms-simple','armY','팔 전체 들기',.01],['arms-simple','armPos','팔 전체 위치',.01],
  ['eyes','eyeCY','감은 눈 높이',.01],['eyes','eyeCAng','감은 눈 기울기',.01],['eyes','eyeScaleL','감은 눈 크기 (왼쪽)',.01],['eyes','eyeScaleR','감은 눈 크기 (오른쪽)',.01],
  ['eyes','eyeLid','눈꺼풀로 감기',1],['eyes','eyeEase','감은 눈으로 바뀌는 시점',.01],['eyes','irisScale','눈동자 크기',.01],
  ['mouth','mouthCY','다문 입 높이',.01],['mouth','mouthCAng','다문 입 기울기',.01],['mouth','mouthScale','입 크기',.01],['mouth','mouthEase','벌린 입으로 바뀌는 시점',.01],
  ['physics','fhAmp','앞머리',.01],['physics','fhSoft','앞머리 끝 부드럽게',.01],['physics','physAmp','뒷머리',.01],['physics','soft','뒷머리 끝 부드럽게',.01],
  ['physics','accAmp','귀걸이 · 장신구',.01],['physics','bust','가슴',.01],['physics','bustY','가슴 흔들리는 위치',.01]
];
const DEFAULTS=Object.assign({},Core.DEFAULTS);
const T=Object.assign({},DEFAULTS);
const cur=Object.assign({},DEFAULTS);
const auto={idle:true,blink:true,rand:true,talk:true,mouse:false,mic:false,phys:true,cam:false};
const autoDefaults={...auto};

// One range + number box. onValue(value, final) is called on edits.
function makeRow(id,label,min,max,step,value){
  const row=document.createElement('div');row.className='row';
  const lab=document.createElement('label');lab.textContent=label;lab.htmlFor=id;
  const el=document.createElement('input');el.type='range';el.id=id;el.min=min;el.max=max;el.step=step;el.value=value;
  const num=document.createElement('input');num.type='number';num.className='val';num.min=min;num.max=max;num.step=step;num.value=value;num.setAttribute('aria-label',label+' 값');
  row.append(lab,el,num);
  return {row,el,num};
}
function bindRange(r,onValue){
  const {el,num}=r,range=[Number(el.min),Number(el.max)];
  el.addEventListener('input',()=>{num.value=el.value;onValue(Number(el.value),false);});
  el.addEventListener('change',()=>onValue(Number(el.value),true));
  num.addEventListener('input',()=>{if(num.value!==''&&Number.isFinite(num.valueAsNumber)){el.value=RT.clamp(num.valueAsNumber,...range);onValue(Number(el.value),false);}});
  num.addEventListener('change',()=>{if(num.value!==''&&Number.isFinite(num.valueAsNumber))el.value=RT.clamp(num.valueAsNumber,...range);num.value=el.value;onValue(Number(el.value),true);});
  el.title='두 번 누르면 기본값';
  return {range,set(value){el.value=RT.clamp(value,...range);num.value=el.value;return Number(el.value);}};
}
const sliderOf={},parameterRanges={};
// 「캐릭터 맞춤」: what each value does, and the pose the preview takes while it is being changed
// so the effect is visible (closed eyes for closed-eye values, talking for the mouth, head shake for physics).
const TUNE_INFO={
  eyeCY:['closed','감은 눈이 눈보다 위나 아래에 그려지면 맞춥니다'],eyeCAng:['closed','감은 눈선이 눈 모양과 다르게 기울었으면 맞춥니다'],
  eyeScaleL:['closed','화면 왼쪽 감은 눈의 크기'],eyeScaleR:['closed','화면 오른쪽 감은 눈의 크기'],
  eyeLid:['blink','1: 피부색 눈꺼풀이 내려와 감김 (그림체 그대로, 기본). 0: 감은 눈 그림으로 바꿔 끼움'],
  eyeEase:['blink','감은 눈 그림으로 바뀌는 시점 (「눈꺼풀로 감기」가 0일 때만)'],irisScale:['open','눈동자가 흰자보다 크거나 작아 보이면'],
  mouthCY:['closed-mouth','다문 입이 입 위치보다 위나 아래에 그려지면 맞춥니다'],mouthCAng:['closed-mouth','다문 입이 기울어 보이면'],
  mouthScale:['talk','말할 때 입이 얼굴에 비해 크거나 작으면'],mouthEase:['talk','입을 조금 벌릴 때 어색하면 조절'],
  fhAmp:['shake','고개를 돌릴 때 앞머리가 흔들리는 정도'],fhSoft:['shake','앞머리 끝이 늦게 따라오는 정도'],
  physAmp:['shake','뒷머리가 흔들리는 정도'],soft:['shake','뒷머리 끝이 늦게 따라오는 정도'],
  accAmp:['shake','귀걸이·꼬리 같은 장신구가 흔들리는 정도'],bust:['bounce','숨 쉬거나 움직일 때 가슴이 흔들리는 정도'],bustY:['bounce','흔들리는 부분의 높이 (「기준점」의 가슴 점과 같음)']};
let tunePreview=null;   // {kind, until} while a 「캐릭터 맞춤」 slider is held or just changed
function holdTunePreview(key){const info=TUNE_INFO[key];if(info)tunePreview={kind:info[0],until:performance.now()+1800};}
for(const [group,key,label,step] of SLIDERS){
  const [min,max]=Core.RANGES[key];
  const r=makeRow('p_'+key,label,min,max,step,DEFAULTS[key]);
  document.querySelector('[data-group="'+group+'"]').append(r.row);
  if(TUNE_INFO[key]){
    const hint=document.createElement('p');hint.className='row-hint';hint.textContent=TUNE_INFO[key][1];r.row.after(hint);
    for(const ev of ['pointerdown','input','focus','keydown'])r.el.addEventListener(ev,()=>holdTunePreview(key));
    r.num.addEventListener('input',()=>holdTunePreview(key));
  }
  const b=bindRange(r,(value,final)=>{
    T[key]=value;if(paused&&lastFrame)lastFrame[key]=value;
    if(activePreset){activePreset=null;highlightPresets();}
    invalidate();if(key==='bustY')renderOverlay();
    if(final)commitHistory();
  });
  sliderOf[key]=b;parameterRanges[key]=b.range;
  r.el.addEventListener('dblclick',()=>{T[key]=b.set(DEFAULTS[key]);if(paused&&lastFrame)lastFrame[key]=T[key];invalidate();commitHistory();});
}
function setSlider(key,val){
  const b=sliderOf[key];if(!b)return;
  T[key]=b.set(val);if(paused&&lastFrame)lastFrame[key]=T[key];invalidate();
}

const toggleIds={idle:'tgIdle',blink:'tgBlink',rand:'tgRand',talk:'tgTalk',cam:'tgCam',mouse:'tgMouse',mic:'tgMic',phys:'tgPhys'};
const toggleLabels={cam:'카메라로 따라하기',mic:'마이크로 입 움직이기'};
function syncToggle(key){const el=$(toggleIds[key]);el.classList.toggle('on',auto[key]);el.setAttribute('aria-pressed',String(auto[key]));}
function setAuto(key,value){
  const changed=auto[key]!==value;
  auto[key]=value;syncToggle(key);
  if(key==='mic'){if(value)startMic();else mic.stop();}
  if(key==='cam'){if(value)startCam();else stopCam();}
  if(key==='mic')updateMicTicker();
  if(key==='blink'&&!value){blinkT=-1;blinkVariant=1;irisBounceT=-1;}
  if(changed&&RT.AUTO_KEYS.includes(key))saveSoon();
}
Object.entries(toggleIds).forEach(([key,id])=>{syncToggle(key);$(id).addEventListener('click',()=>setAuto(key,!auto[key]));});

// ---------- expressions & motions (reactions.json, per model) ----------
// An expression sets every pose slider (Bundle.POSE_KEYS) at once; clearing it returns them to
// the defaults. It may also hold a few tuning values (irisScale): their previous values are kept
// in exprSaved so that clearing, saving settings and exporting use the character's own tuning.
const X=window.CapsuleExpressions,Anim=window.CapsuleAnimator,POSE_KEYS=window.CapsuleBundle.POSE_KEYS;
const EXPR_EXTRA=['irisScale'],REACT_KEY='capsule.reactions.';
const cloneJSON=v=>JSON.parse(JSON.stringify(v));
let defaultReactions=X.normalize({expressions:{neutral:{label:'기본',params:{}}}},Core.RANGES);
let reactions=cloneJSON(defaultReactions);
let activePreset=null,selectedExpr=null,exprSaved={},selectedMotion=null,motionPlay=null;
const defaultReactionsReady=(location.protocol==='file:'?Promise.reject(new Error('file')):fetch('engine/reactions.default.json').then(r=>{if(!r.ok)throw new Error(r.status);return r.json();}))
  .then(v=>{defaultReactions=X.normalize(v,Core.RANGES);if(!layers.length){reactions=cloneJSON(defaultReactions);renderExpressions();renderMotions();}})
  .catch(()=>{$('reactionsStatus').textContent='기본 표정 파일을 읽지 못했습니다 (npm start 주소로 열어 주세요)';});
const exprLabel=n=>(reactions.expressions[n]&&reactions.expressions[n].label)||n;
const motionLabel=n=>(reactions.motions[n]&&reactions.motions[n].label)||n;
function highlightPresets(){document.querySelectorAll('[data-preset]').forEach(b=>{const on=b.dataset.preset===activePreset;b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));});}
function restoreExprSaved(){for(const k in exprSaved)setSlider(k,exprSaved[k]);exprSaved={};}
function applyExpression(name){
  const x=reactions.expressions[name];if(!x)return false;
  restoreExprSaved();
  for(const k of POSE_KEYS)setSlider(k,k in x.params?x.params[k]:DEFAULTS[k]);
  for(const k of EXPR_EXTRA)if(k in x.params){exprSaved[k]=T[k];setSlider(k,x.params[k]);}
  activePreset=name;selectedExpr=name;
  return true;
}
function togglePreset(name){
  if(!reactions.expressions[name])return;
  if(activePreset===name){activePreset=null;restoreExprSaved();for(const k of POSE_KEYS)setSlider(k,DEFAULTS[k]);}
  else applyExpression(name);
  highlightPresets();updateExprEdit();commitHistory();
}
function clearPreset(){if(!activePreset)return;togglePreset(activePreset);}
function renderExpressions(){
  const box=$('exprList');box.replaceChildren();
  Object.keys(reactions.expressions).forEach((n,i)=>{
    const b=document.createElement('button');b.type='button';b.className='btn';b.dataset.preset=n;b.textContent=exprLabel(n);b.title=n;
    if(!defaultReactions.expressions[n])b.classList.add('custom');
    if(i<9){const k=document.createElement('kbd');k.textContent=String(i+1);b.append(k);}
    b.addEventListener('click',()=>togglePreset(n));box.append(b);
  });
  highlightPresets();updateExprEdit();
  $('reactionsText').value=X.stringify(reactions);
}
function updateExprEdit(){
  const n=selectedExpr&&reactions.expressions[selectedExpr]?selectedExpr:null,editable=!!n&&n!=='neutral'&&layers.length>0;
  $('btnExprSave').disabled=!editable;$('btnExprDelete').disabled=!editable;$('btnExprNew').disabled=!layers.length;
  $('btnExprSave').textContent=n&&n!=='neutral'?'「'+exprLabel(n)+'」에 덮어쓰기':'선택한 표정에 덮어쓰기';
  if(document.activeElement!==$('exprLabel'))$('exprLabel').value=n&&n!=='neutral'?exprLabel(n):'';
}
function currentExprParams(){
  const p=X.poseParams(T,DEFAULTS,POSE_KEYS);
  for(const k of EXPR_EXTRA)if(k in exprSaved&&Math.abs(T[k]-exprSaved[k])>1e-3)p[k]=round2(T[k]);
  return p;
}
function loadReactions(){
  let r=null;const saved=storageGet(REACT_KEY+modelId);
  if(saved){try{r=X.normalize(JSON.parse(saved),Core.RANGES);}catch(err){status('저장된 표정·모션을 읽지 못해 기본값을 씁니다',true);}}
  reactions=r||cloneJSON(defaultReactions);
  activePreset=null;selectedExpr=null;exprSaved={};motionPlay=null;
  selectedMotion=Object.keys(reactions.motions)[0]||null;
  $('reactionsStatus').textContent=r?'이 모델용으로 고친 표정·모션입니다 (브라우저에 자동 저장).':'기본 표정·모션입니다. 고치면 이 모델용으로 브라우저에 자동 저장됩니다.';
  renderExpressions();renderMotions();
}
function saveReactions(note){
  try{storageSet(REACT_KEY+modelId,JSON.stringify(reactions));$('reactionsStatus').textContent='이 모델용으로 고친 표정·모션입니다 (브라우저에 자동 저장).';}
  catch(err){status('브라우저에 저장하지 못했습니다. 「파일로 저장」을 써 주세요',true);return;}
  $('reactionsText').value=X.stringify(reactions);
  if(note)status(note);
}
$('btnExprSave').addEventListener('click',()=>{
  const n=selectedExpr,old=reactions.expressions[n];if(!old||n==='neutral')return;
  reactions.expressions[n]=Object.assign({},old,{label:$('exprLabel').value.trim().slice(0,40)||old.label||n,params:currentExprParams()});
  reactions=X.normalize(reactions,Core.RANGES);activePreset=n;renderExpressions();saveReactions('「'+exprLabel(n)+'」 표정을 저장했습니다');
});
$('btnExprNew').addEventListener('click',()=>{
  const n=X.freshName('custom',reactions.expressions),label=$('exprLabel').value.trim().slice(0,40)||'내 표정 '+n.slice(6);
  const params=currentExprParams();
  reactions.expressions[n]={label,params};reactions=X.normalize(reactions,Core.RANGES);
  activePreset=n;selectedExpr=n;renderExpressions();saveReactions('새 표정 「'+label+'」을 저장했습니다 ('+Object.keys(params).length+'개 값)');
});
$('btnExprDelete').addEventListener('click',()=>{
  const n=selectedExpr;if(!reactions.expressions[n]||n==='neutral')return;
  if(!confirm('「'+exprLabel(n)+'」 표정을 지울까요?'))return;
  const used=Object.values(reactions.reactions).some(l=>l.some(c=>c.expression===n||c.then===n));
  delete reactions.expressions[n];if(activePreset===n)clearPreset();selectedExpr=null;
  renderExpressions();saveReactions('표정을 지웠습니다'+(used?' (반응표에서 쓰던 표정이라 그 반응은 표정 없이 재생됩니다)':''));
});

// motions: playing one adds its tracks on top of the preview (like the player's animator)
function playMotion(name){
  const def=reactions.motions[name];if(!def||!layers.length)return;
  motionPlay={name,def,start:simulationTime};status('모션 재생: '+motionLabel(name));
}
function motionKeysOf(name){const m=reactions.motions[name];return m?X.motionKeys(m):[];}
function setMotionKeys(name,keys,note){
  const m=reactions.motions[name];if(!m)return;
  reactions.motions[name]=X.motionFromKeys(m,keys,DEFAULTS);reactions=X.normalize(reactions,Core.RANGES);
  renderMotions();saveReactions(note);
}
function capturePose(mode){
  const p={};
  for(const k of POSE_KEYS){const d=T[k]-DEFAULTS[k];if(Math.abs(d)>1e-3)p[k]=round2(mode==='override'?T[k]:d);}
  return p;
}
function showKeyPose(mode,params){
  activePreset=null;highlightPresets();
  for(const k of POSE_KEYS)setSlider(k,mode==='override'?(k in params?params[k]:DEFAULTS[k]):DEFAULTS[k]+(params[k]||0));
  commitHistory();
}
const PARAM_LABEL=Object.fromEntries(SLIDERS.map(([,k,l])=>[k,l]));
function renderMotions(){
  const names=Object.keys(reactions.motions);
  if(!names.includes(selectedMotion))selectedMotion=names[0]||null;
  const box=$('motionList');box.replaceChildren();
  for(const n of names){
    const b=document.createElement('button');b.type='button';b.className='btn';b.textContent='▶ '+motionLabel(n);b.title=n;b.dataset.motion=n;
    if(!defaultReactions.motions[n])b.classList.add('custom');
    b.addEventListener('click',()=>playMotion(n));box.append(b);
  }
  const sel=$('motionSelect');sel.replaceChildren();
  for(const n of names){const o=document.createElement('option');o.value=n;o.textContent=motionLabel(n);sel.append(o);}
  sel.value=selectedMotion||'';
  const m=selectedMotion?reactions.motions[selectedMotion]:null,on=!!m&&layers.length>0;
  for(const id of ['btnMotionDelete','btnMotionKey','btnMotionPlay'])$(id).disabled=!on;
  $('btnMotionNew').disabled=!layers.length;
  for(const id of ['motionLabel','motionDuration','motionMode','motionKeyTime'])$(id).disabled=!m;
  $('motionLabel').value=m?(m.label||''):'';$('motionDuration').value=m?m.duration:'';$('motionMode').value=m?m.mode:'add';
  const list=$('motionKeys');list.replaceChildren();
  const keys=m?motionKeysOf(selectedMotion):[];
  if(!keys.length){const li=document.createElement('li');li.className='empty';li.textContent=m?'키가 없습니다':'모션이 없습니다';list.append(li);}
  keys.forEach((k,i)=>{
    const li=document.createElement('li');
    const t=document.createElement('span');t.className='key-t';t.textContent=(k.t/1000).toFixed(2)+'초';
    const p=document.createElement('span');p.className='key-p';
    const vals=Object.entries(k.params).filter(([,v])=>m.mode==='override'||Math.abs(v)>1e-3);
    p.textContent=vals.length?vals.map(([q,v])=>(PARAM_LABEL[q]||q)+' '+(v>0&&m.mode!=='override'?'+':'')+v).join(', '):'기본 자세';p.title=p.textContent;
    const mk=(label,title,fn)=>{const b=document.createElement('button');b.type='button';b.className='btn compact';b.textContent=label;b.title=title;b.addEventListener('click',fn);return b;};
    li.append(t,p,
      mk('보기','이 키의 자세를 슬라이더에 놓기',()=>showKeyPose(m.mode,k.params)),
      mk('지금 자세로','이 키를 지금 슬라이더 자세로 바꾸기',()=>{const ks=motionKeysOf(selectedMotion);ks[i].params=capturePose(m.mode);setMotionKeys(selectedMotion,ks,(k.t/1000).toFixed(2)+'초 키를 바꿨습니다');}),
      mk('×','키 지우기',()=>{const ks=motionKeysOf(selectedMotion);ks.splice(i,1);setMotionKeys(selectedMotion,ks,'키를 지웠습니다');}));
    list.append(li);
  });
}
$('motionSelect').addEventListener('change',()=>{selectedMotion=$('motionSelect').value;renderMotions();});
$('motionLabel').addEventListener('change',()=>{const m=reactions.motions[selectedMotion];if(!m)return;m.label=$('motionLabel').value.trim().slice(0,40);reactions=X.normalize(reactions,Core.RANGES);renderMotions();saveReactions();});
$('motionDuration').addEventListener('change',()=>{const m=reactions.motions[selectedMotion];if(!m)return;m.duration=Number($('motionDuration').value)||m.duration;reactions=X.normalize(reactions,Core.RANGES);renderMotions();saveReactions();});
$('motionMode').addEventListener('change',()=>{
  const m=reactions.motions[selectedMotion];if(!m)return;
  const to=$('motionMode').value;if(to===m.mode)return;
  // keep the poses: offsets <-> absolute values
  const keys=motionKeysOf(selectedMotion).map(k=>({t:k.t,params:Object.fromEntries(Object.entries(k.params).map(([p,v])=>[p,round2(to==='override'?DEFAULTS[p]+v:v-DEFAULTS[p])]))}));
  m.mode=to;setMotionKeys(selectedMotion,keys,'모션 방식을 바꿨습니다');
});
$('btnMotionKey').addEventListener('click',()=>{
  const m=reactions.motions[selectedMotion];if(!m)return;
  const t=Math.max(0,Math.round(Number($('motionKeyTime').value)||0));
  const keys=motionKeysOf(selectedMotion).filter(k=>k.t!==t);keys.push({t,params:capturePose(m.mode)});
  setMotionKeys(selectedMotion,keys,(t/1000).toFixed(2)+'초에 키를 넣었습니다');
  $('motionKeyTime').value=String(t+300);
});
$('btnMotionPlay').addEventListener('click',()=>playMotion(selectedMotion));
$('btnMotionNew').addEventListener('click',()=>{
  const n=X.freshName('motion',reactions.motions);
  reactions.motions[n]={label:'내 모션 '+n.slice(6),duration:1500,fadeIn:150,fadeOut:300,mode:'add',tracks:{}};
  reactions=X.normalize(reactions,Core.RANGES);selectedMotion=n;$('motionKeyTime').value='0';$('motionEdit').open=true;
  renderMotions();saveReactions('새 모션을 만들었습니다. 자세를 만들고 「지금 자세를 키로」를 누르세요');
});
$('btnMotionDelete').addEventListener('click',()=>{
  const n=selectedMotion;if(!reactions.motions[n]||!confirm('「'+motionLabel(n)+'」 모션을 지울까요?'))return;
  delete reactions.motions[n];if(motionPlay&&motionPlay.name===n)motionPlay=null;
  renderMotions();saveReactions('모션을 지웠습니다');
});
function replaceReactions(value,note){
  reactions=X.normalize(value,Core.RANGES);
  if(activePreset&&!reactions.expressions[activePreset])clearPreset();
  if(selectedExpr&&!reactions.expressions[selectedExpr])selectedExpr=null;
  motionPlay=null;renderExpressions();renderMotions();saveReactions(note);
}
$('btnReactionsSave').addEventListener('click',()=>{download(new Blob([X.stringify(reactions)],{type:'application/json'}),baseFileName()+'.reactions.json');status('reactions.json을 저장했습니다');});
$('btnReactionsOpen').addEventListener('click',()=>$('reactionsInput').click());
$('reactionsInput').addEventListener('change',async ev=>{
  const f=ev.target.files[0];ev.target.value='';if(!f)return;
  try{if(f.size>1024*1024)throw new Error('1MB 이하여야 합니다');replaceReactions(JSON.parse(await f.text()),'reactions.json을 불러왔습니다');}
  catch(err){status('reactions.json을 불러오지 못했습니다: '+err.message,true);}
});
$('btnReactionsReset').addEventListener('click',()=>{if(confirm('이 모델의 표정·모션을 기본으로 되돌릴까요? (고친 내용은 사라집니다)'))replaceReactions(cloneJSON(defaultReactions),'기본 표정·모션으로 되돌렸습니다');});
$('btnReactionsApply').addEventListener('click',()=>{
  try{replaceReactions(JSON.parse($('reactionsText').value),'reactions.json을 적용했습니다');}
  catch(err){status('적용하지 못했습니다: '+err.message,true);}
});
renderExpressions();renderMotions();

function resetParams(){
  activePreset=null;exprSaved={};motionPlay=null;highlightPresets();
  for(const key in sliderOf)setSlider(key,DEFAULTS[key]);
  Object.assign(cur,T);
}
const BACKGROUNDS={checker:'투명',dark:'어둡게',green:'초록'};
function setBackground(value){
  background=RT.BACKGROUNDS.includes(value)?value:'checker';
  const s=$('stage');s.classList.remove('checker','green','dark');s.classList.add(background);
  $('btnBg').textContent='배경: '+(BACKGROUNDS[background]||'투명');
}
function cycleBackground(){const i=RT.BACKGROUNDS.indexOf(background);setBackground(RT.BACKGROUNDS[(i+1)%RT.BACKGROUNDS.length]);saveSoon();}
$('btnBg').addEventListener('click',cycleBackground);
setBackground(background);

// ---------- settings: auto-saved per model in this browser ----------
function settingsSnapshot(){
  return {format:RT.SETTINGS_FORMAT,version:RT.SETTINGS_VERSION,app:'Capsule Model Studio '+APP_VERSION,modelId,modelName,params:Object.assign({},T,exprSaved),preset:activePreset,
    auto:Object.fromEntries(RT.AUTO_KEYS.map(k=>[k,auto[k]])),background,
    layers:layers.map(L=>({id:L.id,visible:L.visible,opacity:L.opacity,depth:L.depth})),anchors:JSON.parse(JSON.stringify(anchorOffsets))};
}
function defaultLayerOrder(){return layers.slice().sort((a,b)=>a.z-b.z).map(L=>L.id);}
function applySettings(value,opts={}){
  const data=RT.settings(value,modelId,parameterRanges,layers.map(L=>L.id),DEFAULTS,{anyModel:!!opts.anyModel,anchorLimit:Math.max(CW,CH)});
  activePreset=null;exprSaved={};
  for(const [key,n] of Object.entries(data.params))setSlider(key,n);
  if(data.preset&&reactions.expressions[data.preset])applyExpression(data.preset);
  highlightPresets();updateExprEdit();
  Object.assign(cur,T);
  for(const [key,n] of Object.entries(data.auto))if(key!=='cam'&&key!=='mic')setAuto(key,n);
  const byId=new Map(layers.map(L=>[L.id,L])),records=new Map(data.layers.map(r=>[r.id,r]));
  setLayers(RT.mergeLayerOrder(defaultLayerOrder(),data.layers.map(r=>r.id)).map(id=>{
    const L=byId.get(id),r=records.get(id);
    if(r){L.visible=r.visible;L.opacity=r.opacity;L.depth=r.depth;}
    else{L.visible=true;L.opacity=L.defaultOpacity;L.depth=L.defaultDepth;}
    return L;
  }));
  anchorOffsets=data.anchors;applyAnchors();
  setBackground(data.background);renderLayerList();invalidate();
  return data;
}
function layerDiffNote(data){const n=data.missingLayers+data.unknownLayers;return n?' (레이어 구성이 달라 '+n+'개는 기본값)':'';}
function restoreSettings(){
  for(const k of RT.AUTO_KEYS)if(k!=='cam'&&k!=='mic')setAuto(k,autoDefaults[k]);
  const saved=storageGet('anime25d.settings.'+modelId);
  if(!saved)return false;
  try{const data=applySettings(JSON.parse(saved));status('지난번 조정을 불러왔습니다'+layerDiffNote(data));return true;}
  catch(err){status('저장된 조정을 불러오지 못했습니다: '+err.message,true);return false;}
}
let saveTimer=null;
function saveNow(){
  clearTimeout(saveTimer);saveTimer=null;
  if(!layers.length)return;
  try{storageSet('anime25d.settings.'+modelId,JSON.stringify(settingsSnapshot()));}
  catch(err){status('브라우저에 저장하지 못했습니다. 「설정 파일 저장」을 써 주세요',true);}
}
function saveSoon(){if(layers.length){clearTimeout(saveTimer);saveTimer=setTimeout(saveNow,400);}}
window.addEventListener('pagehide',saveNow);
$('btnExportSettings').addEventListener('click',()=>{download(new Blob([JSON.stringify(settingsSnapshot(),null,2)],{type:'application/json'}),baseFileName()+'.rig.json');status('설정 파일을 저장했습니다');});
$('btnImportSettings').addEventListener('click',()=>$('settingsInput').click());
async function importSettingsFile(f){
  const id=modelId;
  try{
    if(!layers.length)throw new Error('먼저 PSD를 열어 주세요');
    if(f.size>1024*1024)throw new Error('설정 파일은 1MB 이하여야 합니다');
    const value=JSON.parse(await f.text());
    if(id!==modelId)throw new Error('그 사이 모델이 바뀌었습니다. 다시 골라 주세요');
    const data=applySettings(value);commitHistory();
    status('설정 파일을 불러왔습니다'+layerDiffNote(data));
  }catch(err){status('설정 파일을 불러오지 못했습니다: '+err.message,true);}
}
$('settingsInput').addEventListener('change',ev=>{const f=ev.target.files[0];ev.target.value='';if(f)importSettingsFile(f);});
$('btnResetAll').addEventListener('click',()=>{
  resetParams();anchorOffsets={};applyAnchors();
  layers.sort((a,b)=>a.z-b.z);for(const L of layers){L.visible=true;L.depth=L.defaultDepth;L.opacity=L.defaultOpacity;}
  renderLayerList();commitHistory();status('모든 조정을 처음 상태로 되돌렸습니다 (실행 취소 가능)');
});

// ---------- Capsule bundle export ----------
// Same files as tools/build-bundle.js, plus everything edited here (anchors,
// tuning parameters, layer order / visibility / opacity / depth).
async function exportBundle(){
  const B=window.CapsuleBundle,st=$('bundleStatus');
  if(!currentRig||!B)return;
  if(typeof CompressionStream==='undefined'){status('이 브라우저는 모델 내보내기를 지원하지 않습니다 (최신 Chrome / Edge를 쓰세요)',true);return;}
  const btn=$('btnExportBundle');btn.disabled=true;
  try{
    status('캡슐 모델 만드는 중…');
    const params=Object.assign({},T,exprSaved);   // a held expression is not tuning
    const manifest=B.buildManifest(currentRig,{
      source:{file:modelName,fingerprint:modelId,tool:'Capsule Model Studio '+APP_VERSION},
      layerState:layers.map(L=>({z:L.z,visible:L.visible,opacity:L.opacity,depth:L.depth})),
      settings:B.tuningSettings(params,Core.DEFAULTS),
      anchorOffsets:JSON.parse(JSON.stringify(anchorOffsets)),
      cleanup:lastPre
    });
    const enc=new TextEncoder(),files=[{name:'rig.json',data:enc.encode(JSON.stringify(manifest,null,1))}];
    const byZ=new Map(currentRig.layers.map(L=>[L.z,L]));
    for(const [i,L] of manifest.layers.entries()){
      status('파츠 PNG 만드는 중… '+(i+1)+'/'+manifest.layers.length);
      files.push({name:L.image,data:await B.encodePNGAsync(byZ.get(L.z).img,B.browserDeflate)});
    }
    const note=' · 표정 '+Object.keys(reactions.expressions).length+'개 · 모션 '+Object.keys(reactions.motions).length+'개';
    files.push({name:'reactions.json',data:enc.encode(X.stringify(reactions))});
    const blob=new Blob([B.zip(files)],{type:'application/zip'});
    download(blob,baseFileName()+'.capsule.zip');
    st.textContent='내보냈습니다: 파츠 '+manifest.layers.length+'개 · '+(blob.size/1e6).toFixed(1)+'MB'+note+'. ZIP을 bundles/이름/ 에 풀면 플레이어에서 재생됩니다.';
    status('캡슐 모델을 내보냈습니다 ('+(blob.size/1e6).toFixed(1)+'MB)');
  }catch(err){st.textContent='내보내기 오류: '+err.message;status('모델을 내보내지 못했습니다: '+err.message,true);}
  finally{btn.disabled=!layers.length;}
}
$('btnExportBundle').addEventListener('click',exportBundle);

// ---------- history ----------
const history=RT.createHistory(150);
function historySnapshot(){
  const p={};for(const k in T)p[k]=round2(T[k]);
  return JSON.stringify({p,x:exprSaved,preset:activePreset,bg:background,a:anchorOffsets,l:layers.map(L=>[L.id,L.visible,round2(L.opacity),round2(L.depth)])});
}
function commitHistory(){
  if(!layers.length)return;
  history.push(historySnapshot());updateHistoryButtons();saveSoon();
}
function restoreHistory(snap,label){
  if(!snap)return;
  const s=JSON.parse(snap);
  for(const k in s.p)setSlider(k,s.p[k]);
  exprSaved=Object.assign({},s.x||{});
  activePreset=s.preset&&reactions.expressions[s.preset]?s.preset:null;highlightPresets();updateExprEdit();
  setBackground(s.bg);
  anchorOffsets=s.a||{};applyAnchors();
  const byId=new Map(layers.map(L=>[L.id,L]));
  setLayers(s.l.map(([id,visible,opacity,depth])=>Object.assign(byId.get(id),{visible,opacity,depth})));
  renderLayerList();invalidate();updateHistoryButtons();saveSoon();
  status(label);
}
function undo(){if(history.canUndo)restoreHistory(history.undo(),'실행 취소');}
function redo(){if(history.canRedo)restoreHistory(history.redo(),'다시 실행');}
function updateHistoryButtons(){$('btnUndo').disabled=!history.canUndo;$('btnRedo').disabled=!history.canRedo;}
$('btnUndo').addEventListener('click',undo);$('btnRedo').addEventListener('click',redo);

function togglePause(){
  paused=!paused;const b=$('btnPause');b.textContent=paused?'재생':'일시정지';b.setAttribute('aria-pressed',String(paused));
  invalidate();status(paused?'일시정지 — 멈춘 자세로 값을 볼 수 있습니다':'재생');
}
$('btnPause').addEventListener('click',togglePause);
$('btnResetLayers').addEventListener('click',()=>{
  layers.sort((a,b)=>a.z-b.z);for(const L of layers){L.visible=true;L.depth=L.defaultDepth;L.opacity=L.defaultOpacity;}
  renderLayerList();invalidate();commitHistory();status('레이어 설정을 처음으로 되돌렸습니다');
});

// ---------- help ----------
let dialogFocus=null;
function openHelp(){dialogFocus=document.activeElement;$('helpOverlay').classList.add('show');$('helpClose').focus();}
function closeDialog(){const open=document.querySelector('.overlay-dialog.show');if(!open)return;open.classList.remove('show');dialogFocus?.focus?.();}
$('btnHelp').addEventListener('click',openHelp);
$('helpClose').addEventListener('click',closeDialog);
$('helpOverlay').addEventListener('click',e=>{if(e.target===$('helpOverlay'))closeDialog();});
const SHORTCUTS=[
  [['Space'],'일시정지 / 재생'],[['1','~','9'],'표정 (같은 키로 해제)'],[['0'],'표정 해제'],
  [['Ctrl','Z'],'실행 취소'],[['Ctrl','Shift','Z'],'다시 실행 (Ctrl+Y도 됨)'],[['Ctrl','O'],'PSD 열기'],
  [['E'],'기준점 맞추기'],[['F'],'미리보기 전체 보기'],[['B'],'배경 바꾸기'],
  [['휠'],'미리보기 확대·축소'],[['끌기'],'확대한 미리보기 이동'],[['?'],'도움말'],[['Esc'],'도움말·기준점 맞추기 닫기']];
$('shortcutTable').innerHTML=SHORTCUTS.map(([keys,desc])=>'<tr><td>'+keys.map(k=>k==='~'?'~':'<kbd>'+k+'</kbd>').join(' ')+'</td><td>'+desc+'</td></tr>').join('');

// ---------- keyboard ----------
document.addEventListener('keydown',e=>{
  const dlg=document.querySelector('.overlay-dialog.show');
  if(dlg){
    if(e.key==='Escape'){e.preventDefault();closeDialog();}
    if(e.key==='Tab'){
      const items=[...dlg.querySelectorAll('button,a[href]')];
      if(e.shiftKey&&document.activeElement===items[0]){e.preventDefault();items[items.length-1].focus();}
      else if(!e.shiftKey&&document.activeElement===items[items.length-1]){e.preventDefault();items[0].focus();}
    }
    return;
  }
  const t=e.target,tag=t.tagName;
  const textEntry=(tag==='INPUT'&&!['range','checkbox','button'].includes(t.type))||tag==='TEXTAREA'||tag==='SELECT'||t.isContentEditable;
  const mod=e.ctrlKey||e.metaKey,k=e.key.toLowerCase();
  if(mod&&!e.altKey){
    if(k==='s'){e.preventDefault();saveNow();status('자동 저장되고 있습니다');return;}
    if(k==='o'){e.preventDefault();if(!e.repeat)$('fileInput').click();return;}
    if(textEntry)return;   // native undo inside text boxes
    if(k==='z'&&!e.shiftKey){e.preventDefault();undo();}
    else if((k==='z'&&e.shiftKey)||k==='y'){e.preventDefault();redo();}
    return;
  }
  if(textEntry||e.altKey||e.ctrlKey||e.metaKey)return;
  if(e.repeat&&!e.key.startsWith('Arrow')){if(e.code==='Space'||/^[0-9ebf?]$/i.test(e.key))e.preventDefault();return;}
  if(t.closest&&t.closest('#overlay .handle')&&e.key.startsWith('Arrow'))return;   // arrow keys move anchors
  if(t.closest&&t.closest('.tabs')&&e.key.startsWith('Arrow'))return;
  if(e.code==='Space'){
    if(layers.length&&!/BUTTON|INPUT|SUMMARY/.test(tag)&&!t.closest('[role="button"]')){e.preventDefault();togglePause();}
    return;
  }
  if(/^[0-9]$/.test(e.key)&&layers.length){e.preventDefault();if(e.key==='0')clearPreset();else{const n=Object.keys(reactions.expressions)[Number(e.key)-1];if(n)togglePreset(n);}return;}
  if(k==='e'&&layers.length){e.preventDefault();setAnchorMode(!anchorMode);return;}
  if(k==='f'){e.preventDefault();resetView();return;}
  if(k==='b'){e.preventDefault();cycleBackground();return;}
  if(e.key==='?'){e.preventDefault();openHelp();return;}
  if(e.key==='Escape'&&anchorMode){e.preventDefault();setAnchorMode(false);}
});

// ---------- layer list ----------
const expandedLayers=new Set();let dragLayerIndex=-1;
function layerRole(L){
  const parts=[];
  const role=window.Rigger.roleLabel?window.Rigger.roleLabel(L.bn):null;
  parts.push(role||(L.unknown?'모름 → '+(L.group==='head'?'머리':'몸')+'를 따라감':L.bn));
  if(L.side)parts.push(L.side==='L'?'왼쪽':'오른쪽');
  if(L.aw)parts.push('관절');
  if(L.strands&&L.strands.length)parts.push((L.phys==='sway'?'흔들림':'머리 가닥')+' '+L.strands.length);
  if(L.synthetic)parts.push('자동 생성');
  if(L.carved)parts.push('팔과 분리');
  return parts.join(' · ');
}
function moveLayer(from,to){
  if(from===to||from<0||to<0||from>=layers.length||to>=layers.length)return;
  const [L]=layers.splice(from,1);layers.splice(to,0,L);
  renderLayerList();invalidate();commitHistory();
}
function renderLayerList(){
  const container=$('layers');container.replaceChildren();
  layers.forEach((L,i)=>{
    const nm=L.source||L.name;
    const card=document.createElement('div');card.className='layer-card';card.classList.toggle('is-hidden',!L.visible);card.dataset.index=i;
    const top=document.createElement('div');top.className='layer-top';
    const thumb=document.createElement('img');thumb.className='layer-thumb';thumb.alt='';thumb.draggable=true;thumb.title='끌어서 순서 바꾸기';
    if(L.thumb)thumb.src=L.thumb;
    thumb.addEventListener('dragstart',e=>{dragLayerIndex=i;card.classList.add('dragging');e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/x-anime25d-layer',String(i));});
    thumb.addEventListener('dragend',()=>{dragLayerIndex=-1;card.classList.remove('dragging');container.querySelectorAll('.drag-over').forEach(c=>c.classList.remove('drag-over'));});
    card.addEventListener('dragover',e=>{if(dragLayerIndex<0)return;e.preventDefault();card.classList.add('drag-over');});
    card.addEventListener('dragleave',()=>card.classList.remove('drag-over'));
    card.addEventListener('drop',e=>{if(dragLayerIndex<0)return;e.preventDefault();e.stopPropagation();moveLayer(dragLayerIndex,i);});
    const visible=document.createElement('input');visible.type='checkbox';visible.checked=L.visible;visible.setAttribute('aria-label',nm+' 보이기');
    visible.addEventListener('change',()=>{L.visible=visible.checked;card.classList.toggle('is-hidden',!L.visible);invalidate();commitHistory();});
    const text=document.createElement('div');text.className='layer-text';
    const name=document.createElement('span');name.className='layer-name';name.textContent=nm;name.title=nm+(L.source&&L.source!==L.name?' → '+L.name:'');
    const role=document.createElement('span');role.className='layer-role';role.classList.toggle('unknown',!!L.unknown);role.textContent=layerRole(L);
    text.append(name,role);
    top.append(thumb,visible,text);
    for(const d of [-1,1]){
      const b=document.createElement('button');b.type='button';b.className='ord';b.textContent=d<0?'↑':'↓';
      b.setAttribute('aria-label',nm+(d<0?' 뒤로':' 앞으로'));b.disabled=i+d<0||i+d>=layers.length;
      b.addEventListener('click',()=>{moveLayer(i,i+d);container.children[i+d]?.querySelector(d<0?'.ord':'.ord:nth-of-type(2)')?.focus();});
      top.append(b);
    }
    const more=document.createElement('button');more.type='button';more.className='more-btn';
    const open=expandedLayers.has(L.id);more.textContent=open?'▾':'▸';more.setAttribute('aria-expanded',String(open));more.setAttribute('aria-label',nm+' 자세히');
    top.append(more);card.append(top);
    const details=document.createElement('div');details.className='layer-details';details.hidden=!open;
    more.addEventListener('click',()=>{const now=!expandedLayers.has(L.id);if(now)expandedLayers.add(L.id);else expandedLayers.delete(L.id);details.hidden=!now;more.textContent=now?'▾':'▸';more.setAttribute('aria-expanded',String(now));});
    for(const [key,label,max] of [['opacity','진하기',1],['depth','깊이',2]]){
      const row=document.createElement('div');row.className='row';const caption=document.createElement('label');caption.textContent=label;
      const range=document.createElement('input');range.type='range';range.min='0';range.max=String(max);range.step='0.01';range.value=L[key];range.id='layer-'+i+'-'+key;caption.htmlFor=range.id;range.setAttribute('aria-label',nm+' '+label);
      const value=document.createElement('input');value.type='number';value.min='0';value.max=String(max);value.step='0.01';value.value=L[key];value.setAttribute('aria-label',nm+' '+label+' 값');
      range.addEventListener('input',()=>{L[key]=Number(range.value);value.value=range.value;invalidate();});
      range.addEventListener('change',commitHistory);
      value.addEventListener('input',()=>{if(value.value!==''&&Number.isFinite(value.valueAsNumber)){L[key]=RT.clamp(value.valueAsNumber,0,max);range.value=L[key];invalidate();}});
      value.addEventListener('change',()=>{if(value.value!==''&&Number.isFinite(value.valueAsNumber))L[key]=RT.clamp(value.valueAsNumber,0,max);range.value=L[key];value.value=L[key];invalidate();commitHistory();});
      row.append(caption,range,value);details.append(row);
    }
    card.append(details);
    card.addEventListener('mouseenter',()=>{highlightLayer=L.id;renderOverlay();});
    card.addEventListener('mouseleave',()=>{if(highlightLayer===L.id){highlightLayer=null;renderOverlay();}});
    container.append(card);
  });
  if(!layers.length){const p=document.createElement('p');p.className='hint';p.textContent='PSD를 열면 표시됩니다';container.append(p);}
}

// ---------- diagnostics ----------
function renderDiagnostics(rig){
  const list=$('diagnostics');list.replaceChildren();
  const real=bn=>layers.filter(L=>L.bn===bn&&!L.synthetic),synth=bn=>layers.some(L=>L.bn===bn&&L.synthetic);
  const sides=bn=>new Set(real(bn).map(L=>L.side).filter(Boolean)).size;
  const add=(cls,text,note)=>{const li=document.createElement('li');li.className=cls;const d=document.createElement('div');d.textContent=text;if(note){const s=document.createElement('small');s.textContent=note;d.append(s);}li.append(d);list.append(li);};
  const eyePart=(bn,label,required)=>{const n=sides(bn);if(n>=2)add('ok',label);else if(n===1)add('warn',label,'한쪽만 있습니다');else add(required?'bad':'warn',label,'없습니다');};
  add(real('face').length?'ok':'bad','얼굴',real('face').length?'':'없어서 얼굴 위치를 짐작했습니다');
  eyePart('eyewhite','흰자',true);eyePart('irides','눈동자',true);eyePart('eyelash','속눈썹',false);
  const ec=sides('eye_close');
  if(ec>=2)add('ok','감은 눈');else if(synth('eye_close'))add('auto','감은 눈','기본 모양을 자동으로 넣음 (캐릭터 맞춤 → 눈에서 맞추기)');else add('warn','감은 눈','없어서 눈꺼풀을 눌러서 깜빡입니다');
  eyePart('eyebrow','눈썹',false);
  add(real('mouth_open').length?'ok':'bad','벌린 입',real('mouth_open').length?'':'없어서 말할 때 입이 안 움직입니다');
  if(real('mouth_close').length)add('ok','다문 입');else if(synth('mouth_close'))add('auto','다문 입','기본 모양을 자동으로 넣음 (캐릭터 맞춤 → 입에서 맞추기)');else add('warn','다문 입','없습니다');
  const strands=bn=>layers.filter(L=>L.bn===bn).reduce((s,L)=>s+(L.strands?L.strands.length:0),0);
  const hair=['front hair','side hair','ahoge','back hair'].filter(bn=>layers.some(L=>L.bn===bn));
  if(hair.length)add('ok','머리카락 흔들림',hair.map(bn=>(Rigger.roleLabel(bn)||bn)+' '+strands(bn)+'가닥').join(' · '));
  else add('warn','머리카락 흔들림','앞머리 / 뒷머리 레이어가 없습니다');
  const armSides=['L','R'].filter(s=>rig.anchors['arm'+s]);
  if(armSides.length===2)add('ok','팔 관절',['L','R'].map(s=>{const a=rig.anchors['arm'+s];return (s==='L'?'왼':'오른')+'팔 팔꿈치 '+(a.elbowBy==='bend'?'굽은 곳':'비율 추정')+(a.cut?' · 손목 화면 밖':'');}).join(' / ')+(layers.some(L=>L.carved)?' · 몸통 레이어에서 팔을 잘라 냄 (팔 뒤는 자동 채움)':''));
  else if(armSides.length)add('warn','팔 관절','한쪽만 검출됐습니다');
  else if(layers.some(L=>L.bn==='handwear'))add('warn','팔 관절',rig.warnings.find(w=>/팔 리그/.test(w))?'팔 레이어에 몸통이 섞여 관절을 끔 (팔 전체 올리기만 됨)':'관절을 찾지 못했습니다');
  else add('warn','팔 관절','팔 레이어(handwear)가 없습니다');
  const unknown=layers.filter(L=>L.unknown);
  if(unknown.length)add('warn','모르는 레이어 '+unknown.length+'개',unknown.map(L=>L.source||L.name).join(', ')+' (이름을 규칙에 맞추면 움직입니다)');
  for(const w of rig.warnings)if(/빈 레이어|기준점/.test(w))add('warn',w);
  const nStr=layers.reduce((s,L)=>s+(L.strands?L.strands.length:0),0);
  $('rigInfo').textContent='파츠 '+layers.length+'개 · 흔들리는 가닥 '+nStr+'개 · '+CW+' × '+CH+'px';
}

// ---------- preview: fit, zoom & pan ----------
const stage=$('stage'),vp=$('viewport'),view={z:1,x:0,y:0};let fitScale=1,baseLeft=0,baseTop=0;
function fit(){
  const W=stage.clientWidth,H=stage.clientHeight;
  fitScale=Math.max(1e-3,Math.min(W/CW,H/CH));
  const w=CW*fitScale,h=CH*fitScale;baseLeft=(W-w)/2;baseTop=(H-h)/2;
  vp.style.width=w+'px';vp.style.height=h+'px';applyView();
}
function applyView(){
  vp.style.transform='translate('+(baseLeft+view.x)+'px,'+(baseTop+view.y)+'px) scale('+view.z+')';
  const isFit=view.z===1&&!view.x&&!view.y;
  $('btnZoom').textContent=isFit?'전체':Math.round(fitScale*view.z*100)+'%';
  renderOverlay();
}
function resetView(){view.z=1;view.x=0;view.y=0;applyView();}
function zoomAt(factor,cx,cy){
  const z2=clamp(view.z*factor,0.5,16);
  const lx=(cx-baseLeft-view.x)/view.z,ly=(cy-baseTop-view.y)/view.z;
  view.x=cx-baseLeft-z2*lx;view.y=cy-baseTop-z2*ly;view.z=z2;applyView();
}
window.addEventListener('resize',fit);
if(typeof ResizeObserver!=='undefined')new ResizeObserver(fit).observe(stage);
$('btnZoom').addEventListener('click',resetView);
const pointers=new Map();let pinch=null;
function stagePoint(e){const r=stage.getBoundingClientRect();return {x:e.clientX-r.left,y:e.clientY-r.top};}
function panTarget(e){return layers.length&&!e.target.closest('#drop,#stageTools,#camPreview,#overlay .handle,button');}
stage.addEventListener('wheel',e=>{
  if(!layers.length||e.target.closest('#drop,#camPreview'))return;
  e.preventDefault();const p=stagePoint(e),dy=e.deltaMode===1?e.deltaY*16:e.deltaY;
  zoomAt(Math.exp(-dy*0.0015),p.x,p.y);
},{passive:false});
stage.addEventListener('pointerdown',e=>{
  if(!panTarget(e)||(e.pointerType==='mouse'&&e.button!==0&&e.button!==1))return;
  stage.setPointerCapture(e.pointerId);pointers.set(e.pointerId,stagePoint(e));
  if(pointers.size===2){const [a,b]=[...pointers.values()];pinch={d:Math.hypot(a.x-b.x,a.y-b.y),m:{x:(a.x+b.x)/2,y:(a.y+b.y)/2}};}
  stage.classList.add('panning');
});
stage.addEventListener('pointermove',e=>{
  if(!pointers.has(e.pointerId))return;
  const prev=pointers.get(e.pointerId),p=stagePoint(e);pointers.set(e.pointerId,p);
  if(pointers.size===1){view.x+=p.x-prev.x;view.y+=p.y-prev.y;applyView();}
  else if(pointers.size===2&&pinch){
    const [a,b]=[...pointers.values()],d=Math.hypot(a.x-b.x,a.y-b.y),m={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
    view.x+=m.x-pinch.m.x;view.y+=m.y-pinch.m.y;zoomAt(d/Math.max(1,pinch.d),m.x,m.y);pinch={d,m};
  }
});
const endPointer=e=>{pointers.delete(e.pointerId);if(pointers.size<2)pinch=null;if(!pointers.size)stage.classList.remove('panning');};
stage.addEventListener('pointerup',endPointer);stage.addEventListener('pointercancel',endPointer);
stage.addEventListener('dblclick',e=>{if(panTarget(e))resetView();});

// ---------- overlay: anchors & layer highlight ----------
const overlay=$('overlay'),SVG_NS='http://www.w3.org/2000/svg';
function svg(tag,attrs){const el=document.createElementNS(SVG_NS,tag);for(const k in attrs)el.setAttribute(k,attrs[k]);return el;}
function anchorHandles(){
  const out=[];if(!A)return out;
  out.push({key:'face',label:'얼굴 중심',x:A.face.cx,y:A.face.cy,axes:['dx','dy']});
  for(const s of ['L','R']){
    const e=A['eye'+s];if(!e)continue;const name=s==='L'?'왼눈':'오른눈';
    out.push({key:'eye'+s,label:name,x:e.icx,y:e.icy,axes:['dx','dy'],place:'above'});
    out.push({key:'eye'+s+'Close',label:name+' 감는 선',x:s==='L'?e.x0-4:e.x1+4,y:e.closeY,axes:['dy'],cls:'close',guide:[e.x0,e.x1],place:s==='L'?'left':'right'});
  }
  out.push({key:'mouth',label:'입',x:A.mouth.cx,y:A.mouth.cy,axes:['dx','dy']});
  out.push({key:'neck',label:'목 회전축',x:NP.cx,y:NP.cy,axes:['dx','dy']});
  if(layers.some(L=>L.bn==='topwear'))out.push({key:'chest',label:'가슴',x:CHEST.cx,y:CHEST.cy+T.bustY*70*FS,axes:['dx','dy'],cls:'chest'});
  for(const s of ['L','R']){
    const a=A['arm'+s];if(!a)continue;const nm=s==='L'?'왼팔':'오른팔',pl=s==='L'?'left':'right';
    out.push({key:'arm'+s+'Shoulder',label:nm+' 어깨',x:a.shoulder.x,y:a.shoulder.y,axes:['dx','dy'],cls:'arm',place:pl});
    out.push({key:'arm'+s+'Elbow',label:nm+' 팔꿈치',x:a.elbow.x,y:a.elbow.y,axes:['dx','dy'],cls:'arm',place:pl});
    out.push({key:'arm'+s+'Wrist',label:nm+' 손목'+(a.cut?' (화면 밖 추정)':''),x:a.wrist.x,y:a.wrist.y,axes:['dx','dy'],cls:'arm',place:pl});
  }
  return out;
}
let dragAnchor=null;
function psdPerPx(){const r=overlay.getBoundingClientRect();return r.width>0?CW/r.width:1;}
function renderOverlay(){
  overlay.replaceChildren();
  if(!layers.length)return;
  const u=psdPerPx();
  // Sizes are in PSD units per screen pixel so handles keep their size at any zoom.
  if(highlightLayer){const L=layers.find(x=>x.id===highlightLayer);if(L)overlay.append(svg('rect',{class:'layer-box',x:L.x,y:L.y,width:L.w,height:L.h,'stroke-width':1.5*u}));}
  if(!anchorMode)return;
  for(const s of ['L','R']){const a=A['arm'+s];if(!a)continue;
    overlay.append(svg('polyline',{class:'bone',points:[a.shoulder,a.elbow,a.wrist].map(p=>p.x+','+p.y).join(' '),'stroke-width':2*u,fill:'none'}));}
  for(const h of anchorHandles()){
    if(h.guide)overlay.append(svg('line',{class:'guide',x1:h.guide[0],x2:h.guide[1],y1:h.y,y2:h.y,'stroke-width':u,'stroke-dasharray':4*u+' '+4*u}));
    const g=svg('g',{class:'handle'+(h.cls?' '+h.cls:''),tabindex:'0',role:'button','aria-label':h.label+' (끌거나 화살표 키로 이동)','data-key':h.key});
    if(dragAnchor&&dragAnchor.key===h.key)g.classList.add('dragging');
    g.append(svg('circle',{cx:h.x,cy:h.y,r:7*u,'stroke-width':2*u}));
    const place=h.place||'right';
    const tx=svg('text',{x:place==='left'?h.x-11*u:place==='above'?h.x:h.x+11*u,y:place==='above'?h.y-12*u:h.y+4*u,'font-size':12*u,'stroke-width':3*u,
      'text-anchor':place==='left'?'end':place==='above'?'middle':'start'});
    tx.textContent=h.label;g.append(tx);
    g.addEventListener('pointerdown',e=>startAnchorDrag(e,h));
    g.addEventListener('keydown',e=>nudgeAnchor(e,h));
    overlay.append(g);
  }
}
function toPsd(e){const r=overlay.getBoundingClientRect();return {x:(e.clientX-r.left)/r.width*CW,y:(e.clientY-r.top)/r.height*CH};}
function startAnchorDrag(e,h){
  if(e.button!==undefined&&e.button!==0)return;
  e.preventDefault();e.stopPropagation();
  const id=e.pointerId,start=toPsd(e),base=Object.assign({dx:0,dy:0},anchorOffsets[h.key]);
  dragAnchor={key:h.key};
  if(h.cls==='close')anchorPreview=h.key.slice(3,4);
  // Handles are re-created on every move, so follow the pointer on window.
  const move=ev=>{
    if(ev.pointerId!==id)return;
    const p=toPsd(ev),o={};
    if(h.axes.includes('dx'))o.dx=Math.round(base.dx+p.x-start.x);
    if(h.axes.includes('dy'))o.dy=Math.round(base.dy+p.y-start.y);
    setAnchorOffset(h.key,o);
  };
  const up=ev=>{
    if(ev.pointerId!==id)return;
    window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',up);
    dragAnchor=null;anchorPreview=null;commitHistory();renderOverlay();invalidate();
    overlay.querySelector('[data-key="'+h.key+'"]')?.focus({preventScroll:true});
  };
  window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);window.addEventListener('pointercancel',up);
}
function setAnchorOffset(key,o){
  const clean=RT.anchors({[key]:o},Math.max(CW,CH));
  if(clean[key])anchorOffsets[key]=clean[key];else delete anchorOffsets[key];
  applyAnchors();
}
function nudgeAnchor(e,h){
  const step=e.shiftKey?10:1,d={ArrowLeft:[-step,0],ArrowRight:[step,0],ArrowUp:[0,-step],ArrowDown:[0,step]}[e.key];
  if(!d)return;
  e.preventDefault();e.stopPropagation();
  const o=Object.assign({dx:0,dy:0},anchorOffsets[h.key]);
  if(h.axes.includes('dx'))o.dx+=d[0];if(h.axes.includes('dy'))o.dy+=d[1];
  if(!h.axes.includes('dx'))delete o.dx;
  setAnchorOffset(h.key,o);commitHistory();
  overlay.querySelector('[data-key="'+h.key+'"]')?.focus();
}
function setAnchorMode(on){
  on=!!on&&layers.length>0;
  if(anchorMode===on)return;
  anchorMode=on;anchorPreview=null;
  for(const id of ['btnAnchorMode','btnAnchorMode2'])$(id).setAttribute('aria-pressed',String(on));
  $('anchorHint').hidden=!on;
  if(!on)Object.assign(cur,T);
  renderOverlay();invalidate();
  if(on)status('기준점 맞추기 — 멈춘 기본 자세에서 점을 옮깁니다');
}
$('btnAnchorMode').addEventListener('click',()=>setAnchorMode(!anchorMode));
$('btnAnchorMode2').addEventListener('click',()=>setAnchorMode(!anchorMode));
$('btnResetAnchors').addEventListener('click',()=>{anchorOffsets={};applyAnchors();commitHistory();status('기준점을 자동 위치로 되돌렸습니다');});

// ---------- preferences (per browser) ----------
const PREF_SCHEMA={
  headGain:[0.3,2,1],eyeGain:[0.5,2,1],mouthGain:[0.5,2.5,1],browGain:[0,2,1],gazeGain:[0,2,1],smoothing:[0,1,0.5],
  linkEyes:['bool',true],trackBrow:['bool',true],trackSmile:['bool',true],trackHands:['bool',true],camPreview:['bool',true],
  micGain:[0.25,4,1],micGate:[0,0.5,0.05],calibration:['any',null]};
let prefs=RT.prefs(null,PREF_SCHEMA);
try{prefs=RT.prefs(JSON.parse(storageGet('anime25d.prefs')||'null'),PREF_SCHEMA);}catch(err){}
if(!prefs.calibration||typeof prefs.calibration!=='object'||!Object.keys(FF.DEFAULT_NEUTRAL).every(k=>Number.isFinite(prefs.calibration[k])))prefs.calibration=null;
let prefTimer=null;
function savePrefs(){clearTimeout(prefTimer);prefTimer=setTimeout(()=>{try{storageSet('anime25d.prefs',JSON.stringify(prefs));}catch(err){}},200);}
const PREF_SLIDERS=[['headGain','머리 감도'],['eyeGain','깜빡임 감도'],['mouthGain','입 감도'],['browGain','눈썹 감도'],['gazeGain','시선 감도'],['smoothing','부드러움'],['micGain','마이크 감도'],['micGate','잡음 차단']];
for(const [key,label] of PREF_SLIDERS){
  const [min,max,def]=PREF_SCHEMA[key];
  const r=makeRow('pref_'+key,label,min,max,0.01,prefs[key]);$('prefRows').append(r.row);
  const b=bindRange(r,value=>{prefs[key]=value;savePrefs();tracker.setOptions(trackerOptions());});
  r.el.addEventListener('dblclick',()=>{prefs[key]=b.set(def);savePrefs();tracker.setOptions(trackerOptions());});
}
const prefChecks={prefLinkEyes:'linkEyes',prefTrackBrow:'trackBrow',prefTrackSmile:'trackSmile',prefTrackHands:'trackHands',prefCamPreview:'camPreview'};
for(const [id,key] of Object.entries(prefChecks)){
  const el=$(id);el.checked=prefs[key];
  el.addEventListener('change',()=>{prefs[key]=el.checked;savePrefs();tracker.setOptions(trackerOptions());if(key==='camPreview')updateCamPreview();});
}

// ---------- mouse follow ----------
const mouse={x:0,y:0,in:false};
cv.addEventListener('mousemove',e=>{const r=cv.getBoundingClientRect();mouse.x=clamp((e.clientX-r.left)/r.width*2-1,-1.5,1.5);mouse.y=clamp((e.clientY-r.top)/r.height*2-1,-1.5,1.5);mouse.in=true;});
cv.addEventListener('mouseleave',()=>mouse.in=false);

// ---------- camera & microphone ----------
function trackerOptions(){return {headGain:prefs.headGain,eyeGain:prefs.eyeGain,mouthGain:prefs.mouthGain,browGain:prefs.browGain,gazeGain:prefs.gazeGain,smoothing:prefs.smoothing,linkEyes:prefs.linkEyes,trackBrow:prefs.trackBrow,trackSmile:prefs.trackSmile};}
const tracker=new FF.Tracker(trackerOptions());
tracker.setCalibration(prefs.calibration);
const cam={live:false,ax:0,ay:0,az:0,eL:1,eR:1,mo:0,ex:0,ey:0,br:0,mf:0};
let lastTrackingAt=0,camPhysScale=1,micLevel=0;
// hands: wrists -> avatar arms (engine/tracking.js, the same mapping the Capsule front end can use)
const TR=window.CapsuleTracking,armTracker=TR.createArmTracker();
let faceBox=null,lastHandsAt=0,handsState='off';
function feedHands(wrists){armTracker.update({face:faceBox,hands:wrists},performance.now()/1000);lastHandsAt=performance.now();}
function camChip(text,busy){const el=$('tgCam');el.textContent=text;el.classList.toggle('busy',!!busy);}
const camera=window.RigDevices.createCamera({
  preview:$('camCanvas'),
  onState:(s,msg)=>{
    if(s==='loading')camChip('카메라 준비 중…',true);
    else if(s==='on'){camChip('카메라 따라하는 중');tracker.reset();armTracker.reset();faceBox=null;}
    else camChip(toggleLabels.cam);
    if(s==='error'){auto.cam=false;syncToggle('cam');status(msg,true);cam.live=false;}
    $('btnCalibrate').disabled=s!=='on';updateCamPreview();
  },
  onResults:(lm,video)=>{
    const aspect=video.videoWidth&&video.videoHeight?video.videoWidth/video.videoHeight:4/3;
    const out=lm?tracker.update(lm,performance.now()/1000,aspect):null;
    if(!out){cam.live=false;return;}
    faceBox=TR.faceBoxFromMesh(lm,aspect);
    Object.assign(cam,out);cam.live=true;lastTrackingAt=performance.now();
  },
  hands:()=>auto.cam&&prefs.trackHands,
  onHands:(res,video)=>{
    const aspect=video&&video.videoWidth&&video.videoHeight?video.videoWidth/video.videoHeight:4/3;
    feedHands(res&&faceBox?TR.wristsFromHands(res,aspect):[]);
  },
  onHandsState:(s,msg)=>{handsState=s;if(s==='error')status('손 추적을 켜지 못했습니다 (얼굴만 따라 합니다): '+msg,true);}
});
function startCam(){
  camera.start().catch(err=>{auto.cam=false;syncToggle('cam');camChip(toggleLabels.cam);status('카메라를 켜지 못했습니다: '+err.message,true);});
}
function stopCam(){camera.stop();cam.live=false;lastTrackingAt=0;}
function updateCamPreview(){$('camPreview').hidden=!prefs.camPreview||!camera.active;}
$('camPreviewClose').addEventListener('click',()=>{prefs.camPreview=false;$('prefCamPreview').checked=false;savePrefs();updateCamPreview();});
function calibrationText(){$('calibrationStatus').textContent=prefs.calibration?'기억됨 (내 자연스러운 표정을 기준으로 판단합니다)':'기억 안 됨 (보통 얼굴 비율로 판단합니다)';$('btnClearCalibration').disabled=!prefs.calibration;}
calibrationText();
$('btnCalibrate').addEventListener('click',()=>{
  if(!camera.active)return;
  tracker.startCalibration();$('btnCalibrate').disabled=true;status('정면을 보고 자연스러운 표정으로 1초쯤 기다려 주세요…');
  // Average at least 1 s and 5 frames (slow PCs track fewer frames per second).
  const started=performance.now();
  const poll=setInterval(()=>{
    const n=tracker.samples?tracker.samples.length:0,elapsed=performance.now()-started;
    if(camera.active&&elapsed<6000&&(elapsed<1000||n<5))return;
    clearInterval(poll);
    const c=tracker.finishCalibration();$('btnCalibrate').disabled=!camera.active;
    if(!c){status('얼굴을 찾지 못해 기억하지 못했습니다',true);return;}
    prefs.calibration=c;savePrefs();calibrationText();tracker.reset();status('정면 표정을 기억했습니다 ('+n+'프레임)');
  },100);
});
$('btnClearCalibration').addEventListener('click',()=>{prefs.calibration=null;tracker.setCalibration(null);savePrefs();calibrationText();status('기억을 지웠습니다');});

function micChip(text,busy){const el=$('tgMic');el.textContent=text;el.classList.toggle('busy',!!busy);}
const mic=window.RigDevices.createMic({onState:(s,msg)=>{
  if(s==='loading')micChip('마이크 준비 중…',true);
  else if(s==='on')micChip('마이크 듣는 중');
  else micChip(toggleLabels.mic);
  if(s==='error'){auto.mic=false;syncToggle('mic');status(msg,true);updateMicTicker();}
}});
function startMic(){mic.start().catch(err=>{auto.mic=false;syncToggle('mic');micChip(toggleLabels.mic);status('마이크를 켜지 못했습니다: '+err.message,true);updateMicTicker();});}
// Microphone sampling runs on a worker-driven ticker so it keeps going in a background tab.
let micTicker=null;
function updateMicTicker(){
  if(auto.mic&&!micTicker)micTicker=window.RigDevices.createTicker(20,()=>{micLevel=mic.active?mic.sample(prefs.micGain,prefs.micGate):0;});
  else if(!auto.mic&&micTicker){micTicker.stop();micTicker=null;micLevel=0;}
}
let meterAt=0;
function updateMeter(now){
  if(now-meterAt<50)return;meterAt=now;
  const m=$('micMeter');if(m.offsetParent===null)return;
  m.querySelector('.meter-level').style.width=(mic.active?Math.round(clamp(mic.raw*prefs.micGain,0,1)*100):0)+'%';
  m.querySelector('.meter-gate').style.left=Math.round(prefs.micGate*100)+'%';
}

// ---------- animation ----------
let blinkT=-1,blinkVariant=1,blinkBounceStarted=false,irisBounceT=-1,nextBlink=performance.now()+1800;
const rnd={ax:0,ay:0,az:0,bd:0,ex:0,ey:0};let nextRnd=0;
let talkOn=false,talkV=0,talkTgt=0,nextTalkState=0,nextSyl=0;

// Still pose used while editing anchors: handles line up with the drawing.
function restPose(dt){
  const e=Object.assign({},T,{angleX:0,angleY:0,angleZ:0,body:0,eyeX:0,eyeY:0,irisBounceX:1,irisBounceY:1,breath:0,breathHead:0});
  for(const k of Core.ARM_KEYS)e[k]=0;   // arm joints are edited on the rest pose
  if(anchorPreview==='L')e.eyeOpenL=0;if(anchorPreview==='R')e.eyeOpenR=0;
  Core.updateSprings(model,e,0,dt,false);
  return e;
}
function animate(now,dt){
  if(anchorMode)return restPose(dt);
  const t=now/1000;
  const tgt=Object.assign({},T);
  const tuneKind=tunePreview&&performance.now()<tunePreview.until?tunePreview.kind:null;
  const camLive=auto.cam&&cam.live&&performance.now()-lastTrackingAt<1200;
  if(camLive){
    tgt.angleX=clamp(cam.ax,-1,1);tgt.angleY=clamp(cam.ay,-1,1);tgt.angleZ=clamp(cam.az,-1,1);
    tgt.eyeOpenL=Math.min(tgt.eyeOpenL,cam.eL);tgt.eyeOpenR=Math.min(tgt.eyeOpenR,cam.eR);
    tgt.eyeX=clamp(cam.ex,-1,1);tgt.eyeY=clamp(cam.ey,-1,1);
    tgt.mouthOpen=Math.max(tgt.mouthOpen,cam.mo);
    tgt.brow=clamp(tgt.brow+(cam.br||0),-1,1);tgt.mouthForm=clamp(tgt.mouthForm+(cam.mf||0),-1,1);
    tgt.body=clamp(tgt.body+cam.ax*0.25,-1,1);
    if(prefs.trackHands){
      if(performance.now()-lastHandsAt>400)feedHands([]);   // no hand results lately: let the arms settle
      const ap=TR.armParams(model,armTracker.last);
      for(const k in ap)tgt[k]=clamp(tgt[k]+ap[k],-1.5,1.5);
    }
  }
  if(!camLive&&auto.mouse&&mouse.in){tgt.angleX=clamp(mouse.x*0.9,-1,1);tgt.angleY=clamp(-mouse.y*0.7,-1,1);tgt.eyeX=clamp(mouse.x*1.2,-1,1);tgt.eyeY=clamp(-mouse.y*0.8,-1,1);}
  if(auto.idle&&!camLive){
    tgt.angleX+=0.13*Math.sin(t*0.42)+0.05*Math.sin(t*1.13);
    tgt.angleY+=0.08*Math.sin(t*0.31+1.7);
    tgt.angleZ+=0.07*Math.sin(t*0.23+0.5);
    tgt.body+=0.10*Math.sin(t*0.19+2.1);
  }
  if(auto.rand&&!camLive&&!motionPlay&&!tuneKind){
    if(now>nextRnd){nextRnd=now+1400+Math.random()*2600;
      rnd.ax=(Math.random()*2-1)*0.55;rnd.ay=(Math.random()*2-1)*0.40;rnd.az=(Math.random()*2-1)*0.35;
      rnd.bd=(Math.random()*2-1)*0.30;rnd.ex=(Math.random()*2-1)*0.60;rnd.ey=(Math.random()*2-1)*0.35;}
    tgt.angleX=clamp(tgt.angleX+rnd.ax,-1,1);tgt.angleY=clamp(tgt.angleY+rnd.ay,-1,1);
    tgt.angleZ=clamp(tgt.angleZ+rnd.az,-1,1);tgt.body=clamp(tgt.body+rnd.bd,-1,1);
    tgt.eyeX=clamp(tgt.eyeX+rnd.ex,-1,1);tgt.eyeY=clamp(tgt.eyeY+rnd.ey,-1,1);
  }
  if(tuneKind){
    if(tuneKind==='closed'){tgt.eyeOpenL=0;tgt.eyeOpenR=0;}
    else if(tuneKind==='blink'){const v=0.5+0.5*Math.cos(t*2.2);tgt.eyeOpenL=v;tgt.eyeOpenR=v;}
    else if(tuneKind==='open'){tgt.eyeOpenL=1;tgt.eyeOpenR=1;}
    else if(tuneKind==='talk')tgt.mouthOpen=0.5+0.5*Math.sin(t*3.2);
    else if(tuneKind==='closed-mouth')tgt.mouthOpen=0;
    else if(tuneKind==='shake'){tgt.angleX=0.85*Math.sin(t*3.4);tgt.body=0.3*Math.sin(t*3.4);}
    else if(tuneKind==='bounce'){tgt.angleY=0.5*Math.sin(t*4.5);tgt.body=0.4*Math.sin(t*2.2);}
  }
  if(motionPlay){   // same blending as engine/animator.js
    const m=motionPlay,d=m.def,local=now-m.start,dur=d.duration||1000;
    if(local>=dur||!reactions.motions[m.name])motionPlay=null;
    else{
      let w=1;const fi=d.fadeIn||0,fo=d.fadeOut||0;
      if(fi>0&&local<fi)w=Math.min(w,local/fi);if(fo>0&&local>dur-fo)w=Math.min(w,(dur-local)/fo);
      for(const k in d.tracks||{}){if(!(k in tgt))continue;const v=Anim.sampleTrack(d.tracks[k],local);tgt[k]=d.mode==='override'?tgt[k]+(v-tgt[k])*w:tgt[k]+v*w;}
    }
  }
  if(auto.talk&&!camLive&&!auto.mic&&!activePreset&&!tuneKind){
    if(now>nextTalkState){talkOn=!talkOn;nextTalkState=now+(talkOn?1200+Math.random()*2200:600+Math.random()*1800);}
    if(talkOn&&now>nextSyl){nextSyl=now+70+Math.random()*110;talkTgt=Math.random()<0.25?0.04:0.25+Math.random()*0.75;}
    if(!talkOn)talkTgt=0;
    talkV+=(talkTgt-talkV)*Math.min(1,dt*22);
    tgt.mouthOpen=Math.max(tgt.mouthOpen,talkV);
  }
  if(auto.blink&&!camLive&&!activePreset&&!tuneKind){
    if(blinkT<0&&now>nextBlink){blinkT=0;blinkBounceStarted=false;blinkVariant=hasEyeClose2&&Math.random()<0.2?2:1;nextBlink=now+1600+Math.random()*3800;if(Math.random()<0.18)nextBlink=now+280;}
    if(blinkT>=0){blinkT+=dt;
      const d=blinkT,hold=blinkVariant===2?3.4:0.34;let v;
      if(d<0.08)v=1-d/0.08;else if(d<0.08+hold)v=0;else if(d<0.24+hold){
        v=(d-0.08-hold)/0.16;
        if(!blinkBounceStarted&&v>0.12){blinkBounceStarted=true;irisBounceT=0;}
      }else{v=1;blinkT=-1;}
      tgt.eyeOpenL=Math.min(tgt.eyeOpenL,v);tgt.eyeOpenR=Math.min(tgt.eyeOpenR,v);
    }
  }
  if(irisBounceT>=0){irisBounceT+=dt;if(irisBounceT>0.52)irisBounceT=-1;}
  if(auto.mic&&mic.active)tgt.mouthOpen=Math.max(tgt.mouthOpen,micLevel);
  const kSmooth=1-Math.exp(-dt*14);
  for(const k in cur){tgt[k]=RT.clamp(tgt[k],...parameterRanges[k]);cur[k]+=(tgt[k]-cur[k])*kSmooth;}
  const e=Object.assign({},cur);
  e.irisBounceX=1;e.irisBounceY=1;
  if(irisBounceT>=0){
    const p=irisBounceT/0.52,damp=Math.exp(-2.2*p);
    const scale=1+0.18*Math.sin(p*Math.PI*4.0)*damp,squash=0.10*Math.sin(p*Math.PI*4.0+Math.PI/2)*damp;
    e.irisBounceX=scale*(1+squash);e.irisBounceY=scale*(1-squash);
  }
  camPhysScale+=((camLive?0.5:1)-camPhysScale)*Math.min(1,dt*4);   // calmer hair while tracking
  e.physAmp*=camPhysScale;e.soft*=camPhysScale;e.fhAmp*=camPhysScale;e.fhSoft*=camPhysScale;
  e.breath=0.5+0.5*Math.sin(t*2*Math.PI/3.4);
  e.breathHead=0.5+0.5*Math.sin(t*2*Math.PI/3.4-0.6);   // head follows chest with a lag
  Core.updateSprings(model,e,t,dt,auto.idle);
  return e;
}

// ---------- render loop ----------
function render(e){
  model.blinkVariant=blinkVariant;model.physics=auto.phys;
  const {items,masks}=Core.buildFrame(model,e);
  const drawn=new Set();
  for(const it of [...masks,...items])if(!drawn.has(it.L)){drawn.add(it.L);renderer.positions(it.L,it.L.cur);}
  const frame={width:CW,height:CH,background:[0,0,0,0],masks:maskFailed?[]:masks,items};
  try{renderer.draw(frame);}
  catch(err){
    if(maskFailed)throw err;
    maskFailed=true;status(err.message+' (눈동자 자르기를 껐습니다)',true);
    frame.masks=[];renderer.draw(frame);
  }
}
let maskFailed=false;
let last=performance.now(),simulationTime=last,fpsN=0,fpsT=last;
function tick(now){
  requestAnimationFrame(tick);
  const dt=Math.max(0,Math.min(0.05,(now-last)/1000));last=now;
  updateMeter(now);
  if(!layers.length||!A||contextLost)return;
  if(anchorMode||!paused||!lastFrame){simulationTime+=dt*1000;lastFrame=animate(simulationTime,dt);dirty=true;}
  if(dirty){render(lastFrame);dirty=false;}
  fpsN++;if(now-fpsT>500){$('fps').textContent=Math.round(fpsN*1000/(now-fpsT))+' fps';fpsN=0;fpsT=now;}
}
cv.addEventListener('webglcontextlost',ev=>{ev.preventDefault();contextLost=true;status('그리기가 잠시 멈췄습니다. 복구를 기다립니다',true);});
cv.addEventListener('webglcontextrestored',()=>{
  try{
    const saved=currentRig?settingsSnapshot():null;setLayers([]);renderer.init();contextLost=false;
    if(currentRig){applyRig(currentRig);applySettings(saved);}
    status('그리기를 복구했습니다');
  }catch(err){contextLost=true;status('그리기를 복구하지 못했습니다. 페이지를 새로 고쳐 주세요',true);}
});
window.addEventListener('pagehide',()=>{mic.stop(true);camera.stop(true);micTicker?.stop();micTicker=null;cancelLoad();});

// Read-only diagnostics for automated tests and bug reports.
Object.defineProperty(window,'Anime25D',{value:Object.freeze({version:APP_VERSION,state(){
  return {modelId,modelName,layers:layers.length,paused,anchorMode,activePreset,background,
    anchors:JSON.parse(JSON.stringify(anchorOffsets)),params:Object.assign({},T),auto:Object.assign({},auto),
    cam:Object.assign({},cam,{arms:JSON.parse(JSON.stringify(armTracker.last))}),camLive:cam.live&&performance.now()-lastTrackingAt<1200,hands:handsState,calibrated:!!prefs.calibration,
    view:Object.assign({},view),tab:document.querySelector('#panel .tab[aria-selected="true"]').dataset.tab};
}})});

// ---------- start ----------
if(CAMERA_MODE)setAuto('cam',true);
requestAnimationFrame(tick);
})();
