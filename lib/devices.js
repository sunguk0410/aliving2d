/*!
 * Capsule Model Studio — devices.js (based on Anime2.5DRig, MIT)
 * Camera face tracking (MediaPipe FaceMesh, bundled and version-pinned) and
 * microphone level input. Both can be switched off while they are still
 * starting; late permissions are released immediately.
 * MIT License
 */
(function(root){
'use strict';
const FM_VERSION='0.4.1633559619';
const LOCAL_BASE='lib/vendor/face_mesh/';
const CDN_BASE='https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@'+FM_VERSION+'/';
let scriptPromise=null,fmBase=LOCAL_BASE;
// Hands (wrists -> avatar arms). Same pinning as FaceMesh; only the SIMD build and the lite model are bundled.
const H_VERSION='0.4.1675469240',H_LOCAL='lib/vendor/hands/',H_CDN='https://cdn.jsdelivr.net/npm/@mediapipe/hands@'+H_VERSION+'/';
let handsPromise=null,hBase=H_LOCAL;
function loadHands(){
  if(root.Hands)return Promise.resolve();
  if(!handsPromise){
    handsPromise=loadScript(H_LOCAL+'hands.js',8000).then(()=>{hBase=H_LOCAL;})
      .catch(()=>loadScript(H_CDN+'hands.js').then(()=>{hBase=H_CDN;}))
      .catch(err=>{handsPromise=null;throw new Error('손 추적 모델을 받을 수 없습니다');});
  }
  return handsPromise;
}
function locateHands(file){
  if(hBase===H_LOCAL&&((/wasm_bin/.test(file)&&!/simd/.test(file))||/landmark_full/.test(file)))return H_CDN+file;
  return hBase+file;
}
const clamp=(v,a,b)=>v<a?a:v>b?b:v;

function loadScript(url,timeout){
  return new Promise((resolve,reject)=>{
    const s=document.createElement('script');s.src=url;s.async=true;
    const timer=setTimeout(()=>{s.remove();reject(new Error('얼굴 추적 모델을 불러오는 시간이 초과됐습니다'));},timeout||20000);
    s.onload=()=>{clearTimeout(timer);resolve();};
    s.onerror=()=>{clearTimeout(timer);s.remove();reject(new Error('얼굴 추적 모델을 받을 수 없습니다'));};
    document.head.appendChild(s);
  });
}
// Bundled copy first (offline, pinned); the same version from the CDN otherwise.
function loadFaceMesh(){
  if(root.FaceMesh)return Promise.resolve();
  if(!scriptPromise){
    scriptPromise=loadScript(LOCAL_BASE+'face_mesh.js',8000).then(()=>{fmBase=LOCAL_BASE;})
      .catch(()=>loadScript(CDN_BASE+'face_mesh.js').then(()=>{fmBase=CDN_BASE;}))
      .catch(err=>{scriptPromise=null;throw err;});
  }
  return scriptPromise;
}
function locateFile(file){
  // Only the SIMD build is bundled; very old browsers fetch the plain build.
  if(fmBase===LOCAL_BASE&&/wasm_bin/.test(file)&&!/simd/.test(file))return CDN_BASE+file;
  return fmBase+file;
}
function cameraError(err){
  const n=err&&err.name;
  if(n==='NotAllowedError'||n==='PermissionDeniedError')return '브라우저의 카메라 권한을 확인해 주세요';
  if(n==='NotReadableError'||n==='TrackStartError')return '다른 앱이 카메라를 쓰고 있습니다';
  if(n==='NotFoundError'||n==='DevicesNotFoundError')return '카메라를 찾을 수 없습니다';
  if(typeof isSecureContext!=='undefined'&&!isSecureContext)return 'https 또는 localhost 주소로 열어 주세요';
  return (err&&err.message)||String(err);
}

// Timers on the main thread are throttled (down to 1 Hz) when the editor window
// is minimised or covered. Worker timers are not, so tracking and the OBS relay
// keep running while you look at OBS. Falls back to setTimeout.
function createTicker(ms,fn){
  let worker=null,timer=null,stopped=false;
  try{
    const src='let t=null;onmessage=e=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data);};';
    const url=URL.createObjectURL(new Blob([src],{type:'text/javascript'}));
    worker=new Worker(url);URL.revokeObjectURL(url);
    worker.onmessage=()=>{if(!stopped)fn();};
    worker.onerror=()=>{worker.terminate();worker=null;if(!stopped)loop();};
    worker.postMessage(ms);
  }catch(err){worker=null;}
  function loop(){if(stopped)return;fn();timer=setTimeout(loop,ms);}
  if(!worker)timer=setTimeout(loop,ms);
  return {stop(){stopped=true;clearTimeout(timer);if(worker){worker.postMessage(0);worker.terminate();worker=null;}}};
}

// Landmarks drawn on the small preview: eye, brow and mouth outlines.
const PREVIEW_POINTS=[33,133,159,145,263,362,386,374,70,105,107,300,334,336,61,291,13,14,1,468,473];

function createCamera(opts){
  // hands(): whether to track hands now; onHands(results|null, video) per hands frame
  const o=Object.assign({onResults:null,onState:null,preview:null,hands:null,onHands:null,onHandsState:null},opts);
  let gen=0,session=null,lastPreview=0;
  const state=(s,msg)=>{o.onState&&o.onState(s,msg);};
  function drawPreview(video,lm,hands){
    const c=o.preview;if(!c||!c.isConnected||c.offsetParent===null)return;
    const now=performance.now();if(now-lastPreview<60)return;lastPreview=now;
    const ctx=c.getContext('2d'),w=c.width,h=c.height;
    ctx.save();ctx.clearRect(0,0,w,h);ctx.translate(w,0);ctx.scale(-1,1);
    try{ctx.drawImage(video,0,0,w,h);}catch(err){}
    if(lm){ctx.fillStyle='#ff6f91';for(const i of PREVIEW_POINTS){const p=lm[i];if(p)ctx.fillRect(p.x*w-1.5,p.y*h-1.5,3,3);}}
    if(hands&&hands.multiHandLandmarks){ctx.fillStyle='#3fb7ff';for(const hl of hands.multiHandLandmarks){for(const i of [0,5,9,13,17]){const p=hl[i];if(p)ctx.fillRect(p.x*w-2,p.y*h-2,i?3:6,i?3:6);}}}
    ctx.restore();
    if(!lm){ctx.fillStyle='rgba(0,0,0,.55)';ctx.fillRect(0,h-22,w,22);ctx.fillStyle='#ffb3c4';ctx.font='12px sans-serif';ctx.fillText('얼굴을 찾지 못했습니다',8,h-7);}
  }
  function loop(s,token){
    let busy=false,nextAt=0;
    const step=async()=>{
      if(token!==gen||busy)return;
      const v=s.video,t0=performance.now();
      // Poll quickly but only process new video frames, one at a time, and
      // leave the page idle for at least half the processing time (slow PCs).
      if(t0<nextAt||v.readyState<2||v.currentTime===s.lastTime)return;
      busy=true;
      try{
        s.lastTime=v.currentTime;s.frame++;s.pending=s.fm.send({image:v});await s.pending;
        const want=!!(o.hands&&o.hands());
        if(want&&!s.hands&&!s.handsLoading)startHands(s,token);
        if(want&&s.hands&&s.frame%2===0&&token===gen){s.pending=s.hands.send({image:v});await s.pending;}
        else if(!want&&s.handsOn){s.handsOn=false;s.lastHands=null;o.onHands&&o.onHands(null,v);}
      }
      catch(err){if(token===gen){stop();state('error','얼굴 추적이 멈췄습니다. 카메라를 다시 켜 주세요');}}
      finally{busy=false;const t1=performance.now();nextAt=t1+Math.max(8,(t1-t0)*0.5);}
    };
    s.ticker=createTicker(16,step);
  }
  async function start(){
    const token=++gen;let stream=null;
    try{
      if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia)throw new Error('https 또는 localhost 주소로 열어 주세요');
      state('loading');
      if(!root.FaceMesh)await loadFaceMesh();
      if(token!==gen)return false;
      try{stream=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480},facingMode:'user'}});}
      catch(e1){
        if(e1.name==='OverconstrainedError'||e1.name==='ConstraintNotSatisfiedError')stream=await navigator.mediaDevices.getUserMedia({video:true});
        else throw e1;
      }
      if(token!==gen){stream.getTracks().forEach(t=>t.stop());return false;}
      const video=document.createElement('video');video.srcObject=stream;video.muted=true;video.playsInline=true;
      const s={video,stream,fm:null,pending:null,timer:null,lastTime:-1,frame:0,hands:null,handsLoading:false,handsOn:false,lastHands:null};session=s;
      await video.play();
      if(token!==gen)return false;
      s.fm=new root.FaceMesh({locateFile});
      s.fm.setOptions({maxNumFaces:1,refineLandmarks:true,minDetectionConfidence:0.5,minTrackingConfidence:0.5});
      s.fm.onResults(res=>{
        if(token!==gen)return;
        const lm=res&&res.multiFaceLandmarks&&res.multiFaceLandmarks[0]||null;
        drawPreview(video,lm,s.lastHands);
        o.onResults&&o.onResults(lm,video);
      });
      stream.getTracks().forEach(t=>t.addEventListener('ended',()=>{if(token===gen){stop();state('error','카메라 연결이 끊겼습니다');}}));
      state('on');
      loop(s,token);
      return true;
    }catch(err){
      if(stream)try{stream.getTracks().forEach(t=>t.stop());}catch(e){}
      if(token!==gen)return false;
      stop(true);
      throw new Error(cameraError(err));
    }
  }
  // Loaded after FaceMesh is running: both solutions share MediaPipe's global wasm loader,
  // so they must not initialize at the same time.
  async function startHands(s,token){
    s.handsLoading=true;o.onHandsState&&o.onHandsState('loading');
    try{
      await loadHands();
      if(token!==gen)return;
      const hands=new root.Hands({locateFile:locateHands});
      hands.setOptions({maxNumHands:2,modelComplexity:0,minDetectionConfidence:0.6,minTrackingConfidence:0.5,selfieMode:false});
      hands.onResults(res=>{if(token!==gen)return;s.handsOn=true;s.lastHands=res;o.onHands&&o.onHands(res,s.video);});
      if(hands.initialize)await hands.initialize();
      if(token!==gen){hands.close();return;}
      s.hands=hands;o.onHandsState&&o.onHandsState('on');
    }catch(err){
      if(token===gen)o.onHandsState&&o.onHandsState('error',err.message||String(err));
    }
  }
  function stop(quiet){
    gen++;
    const s=session;session=null;
    if(s){
      clearTimeout(s.timer);if(s.ticker)s.ticker.stop();s.stream.getTracks().forEach(t=>t.stop());
      try{s.video.pause();}catch(err){}s.video.srcObject=null;
      Promise.resolve(s.pending).catch(()=>{}).then(()=>{s.fm&&s.fm.close();s.hands&&s.hands.close();}).catch(()=>{});
      if(s.handsOn)o.onHands&&o.onHands(null,s.video);
    }
    if(o.preview){const ctx=o.preview.getContext('2d');ctx&&ctx.clearRect(0,0,o.preview.width,o.preview.height);}
    if(!quiet)state('off');
  }
  return {start,stop,get active(){return !!session;}};
}

function createMic(opts){
  const o=Object.assign({onState:null},opts);
  let gen=0,stream=null,ctx=null,analyser=null,buf=null,level=0,raw=0;
  const state=(s,msg)=>{o.onState&&o.onState(s,msg);};
  async function start(){
    const token=++gen;let st=null,ac=null;
    try{
      if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia)throw new Error('https 또는 localhost 주소로 열어 주세요');
      state('loading');
      st=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:false}});
      if(token!==gen){st.getTracks().forEach(t=>t.stop());return false;}
      const AC=root.AudioContext||root.webkitAudioContext;
      ac=new AC();stream=st;ctx=ac;
      await ac.resume();
      if(token!==gen){st.getTracks().forEach(t=>t.stop());if(ac.state!=='closed')await ac.close();return false;}
      const src=ac.createMediaStreamSource(st);analyser=ac.createAnalyser();analyser.fftSize=512;
      buf=new Uint8Array(analyser.frequencyBinCount);src.connect(analyser);
      st.getTracks().forEach(t=>t.addEventListener('ended',()=>{if(token===gen){stop(true);state('error','마이크 연결이 끊겼습니다');}}));
      state('on');
      return true;
    }catch(err){
      if(st)st.getTracks().forEach(t=>t.stop());
      if(ac&&ac.state!=='closed')ac.close().catch(()=>{});
      if(token!==gen)return false;
      stop(true);
      throw new Error(err.name==='NotAllowedError'?'브라우저의 마이크 권한을 확인해 주세요':err.message);
    }
  }
  function stop(quiet){
    gen++;
    if(stream)stream.getTracks().forEach(t=>t.stop());stream=null;
    if(ctx)ctx.close().catch(()=>{});ctx=null;analyser=null;buf=null;level=0;raw=0;
    if(!quiet)state('off');
  }
  // Speech band energy (≈190 Hz–3.7 kHz) → 0..1 with gain and a noise gate.
  function sample(gain,gate){
    if(!analyser)return 0;
    analyser.getByteFrequencyData(buf);
    let s=0;for(let i=2;i<40;i++)s+=buf[i];s/=38*255;
    raw=clamp(s*3.2,0,1);
    const g=clamp(gate||0,0,0.9),v=clamp((raw*(gain||1)-g)/(1-g),0,1);
    level+=(v-level)*0.45;
    return level;
  }
  return {start,stop,sample,get active(){return !!analyser;},get raw(){return raw;},get level(){return level;}};
}

root.RigDevices={createCamera,createMic,createTicker,FM_VERSION};
})(typeof self!=='undefined'?self:this);
