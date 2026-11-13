'use strict';
// Runs the real index.html inside an iframe with virtual camera/microphone,
// in-memory storage and a synthetic PSD. No real devices are touched.
function installMocks() {
  const pending=[],blobs=[],errors=[],memory=new Map();
  window.harness={pending,blobs,errors,memory,closedAudio:0,closedFace:0,holdVideo:false};
  window.addEventListener('error',e=>errors.push(e.message));
  window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
  Object.defineProperty(window,'localStorage',{value:{getItem:k=>memory.has(k)?memory.get(k):null,setItem:(k,v)=>memory.set(k,String(v)),removeItem:k=>memory.delete(k)}});
  Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:()=>new Promise((resolve,reject)=>pending.push({resolve,reject}))}});
  HTMLMediaElement.prototype.play=function(){return harness.holdVideo?new Promise(resolve=>harness.releaseVideo=resolve):Promise.resolve();};
  HTMLMediaElement.prototype.pause=function(){};
  window.FaceMesh=class {setOptions(){}onResults(fn){this.fn=fn;}send(){this.fn({});return Promise.resolve();}close(){harness.closedFace++;return Promise.resolve();}};
  window.AudioContext=class {constructor(){this.state='running';}resume(){return Promise.resolve();}close(){this.state='closed';harness.closedAudio++;return Promise.resolve();}createMediaStreamSource(){return {connect(){}};}createAnalyser(){return {frequencyBinCount:256,getByteFrequencyData(b){b.fill(0);}};}};
  const originalURL=URL.createObjectURL;
  URL.createObjectURL=blob=>{blobs.push(blob);return originalURL.call(URL,blob);};
  HTMLAnchorElement.prototype.click=function(){};
  // Keep the drawn frame so the test can read the preview's pixels.
  const getContext=HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext=function(type,opts){return getContext.call(this,type,type==='webgl'?Object.assign({},opts,{preserveDrawingBuffer:true}):opts);};
}
const result=document.getElementById('result');
const wait=async(predicate,label,timeout=15000)=>{const start=performance.now();while(!predicate()){if(performance.now()-start>timeout)throw new Error('Timeout: '+label);await new Promise(r=>setTimeout(r,20));}};
let passed=0;
function assert(condition,label){if(!condition)throw new Error(label);passed++;result.textContent+='PASS '+label+'\n';}
document.getElementById('run').addEventListener('click',async()=>{
  document.getElementById('run').disabled=true;result.textContent='';passed=0;
  try{
    const html=await (await fetch('../index.html')).text(),frame=document.createElement('iframe');
    frame.srcdoc=html.replace('<head>','<head><base href="'+new URL('../',location.href).href+'"><script>('+installMocks.toString()+')();<\/script>');
    document.getElementById('frame').replaceChildren(frame);
    await new Promise(r=>frame.addEventListener('load',r,{once:true}));
    const w=frame.contentWindow,d=w.document,h=w.harness;
    await wait(()=>w.Anime25D,'application initialization');
    const S=()=>w.Anime25D.state();
    const $=id=>d.getElementById(id);
    const click=id=>$(id).click();
    const settle=(ms=40)=>new Promise(r=>setTimeout(r,ms));
    const key=(k,opts={},target=d.body)=>target.dispatchEvent(new w.KeyboardEvent('keydown',Object.assign({key:k,bubbles:true,cancelable:true},opts)));
    const stream=()=>{const track=d.createElement('canvas').captureStream(0).getTracks()[0];return {track,media:new w.MediaStream([track])};};

    // ---- start screen: Korean, image-first guidance ----
    assert(d.documentElement.lang==='ko'&&$('drop').textContent.includes('Colab'),'start screen is Korean and explains the Colab step');
    assert(!d.getElementById('obsChip')&&!d.getElementById('btnRecord')&&!d.getElementById('btnPng'),'OBS / recording / PNG controls are gone');

    // ---- devices: late permissions are released, OFF frees everything ----
    click('tgMic');click('tgMic');const lateMic=stream();h.pending.shift().resolve(lateMic.media);await settle();
    assert(lateMic.track.readyState==='ended','microphone permission arriving after OFF releases its track');
    click('tgMic');const mic=stream();h.pending.shift().resolve(mic.media);await wait(()=>$('tgMic').textContent==='마이크 듣는 중','mic starts');click('tgMic');await settle();
    assert(mic.track.readyState==='ended'&&h.closedAudio===1,'microphone OFF closes stream and audio context');
    click('tgCam');click('tgCam');const lateCam=stream();h.pending.shift().resolve(lateCam.media);await settle();
    assert(lateCam.track.readyState==='ended','camera permission arriving after OFF releases its track');
    h.holdVideo=true;click('tgCam');const waitingCam=stream();h.pending.shift().resolve(waitingCam.media);await wait(()=>h.releaseVideo,'video initialization');click('tgCam');h.releaseVideo();await settle();h.holdVideo=false;
    assert(waitingCam.track.readyState==='ended','camera OFF during video initialization cancels the stream');
    click('tgCam');const cam=stream();h.pending.shift().resolve(cam.media);await wait(()=>$('tgCam').textContent==='카메라 따라하는 중','cam starts');
    assert(!$('btnCalibrate').disabled,'calibration is available while tracking');
    click('tgCam');await settle();
    assert(cam.track.readyState==='ended'&&h.closedFace===1&&$('btnCalibrate').disabled,'camera OFF closes stream and face model');

    // ---- a picture without a conversion server explains the Colab flow ----
    function select(input,f){const dt=new w.DataTransfer();dt.items.add(f);input.files=dt.files;input.dispatchEvent(new w.Event('change'));}
    select($('fileInput'),new w.File([new Uint8Array([0x89,0x50,0x4e,0x47])],'art.png',{type:'image/png'}));
    assert($('dropStatus').textContent.includes('Colab')&&$('stJob').hidden,'a picture without a server points to the Colab notebook');

    // ---- synthetic PSD: two eyes, red/blue irises, Japanese and hostile names ----
    function part(name,left,top,width,height,color){const data=new w.Uint8ClampedArray(width*height*4);for(let i=0;i<data.length;i+=4)data.set(color,i);return{name,left,top,right:left+width,bottom:top+height,imageData:{width,height,data}};}
    const psd={width:128,height:128,children:[part('顔',20,10,88,95,[230,160,130,255]),part('eyewhite',30,42,20,12,[255,255,255,255]),part('eyewhite_2',78,42,20,12,[255,255,255,255]),part('irides',35,44,10,8,[255,0,0,255]),part('irides_2',83,44,10,8,[0,0,255,255]),part('mouth_open',53,77,22,8,[120,25,55,255]),part('<img src=x onerror=alert(1)>',1,1,10,10,[255,255,0,255])]};
    const file=new w.File([w.agPsd.writePsd(psd,{generateThumbnail:false})],'test.psd');
    select($('fileInput'),file);
    await wait(()=>$('drop').classList.contains('hidden'),'worker import');
    assert(S().tab==='check'&&!d.querySelector('[data-pane="check"]').hidden,'a new model opens on the check tab');
    assert(!d.querySelector('#layers [onerror]')&&$('layers').textContent.includes('<img'),'layer names are displayed as text');
    assert($('layers').textContent.includes('顔')&&[...d.querySelectorAll('.layer-role')].some(r=>r.textContent.startsWith('얼굴')),'a Japanese layer name resolves to the face role (shown in Korean)');
    assert(d.querySelectorAll('#diagnostics li').length>=8&&d.querySelector('#diagnostics li.ok'),'rig check list is shown');
    assert(d.querySelectorAll('.layer-thumb[src^="data:image/png"]').length>=5,'layer thumbnails are generated');

    // ---- tabs ----
    d.querySelector('.tab[data-tab="tune"]').click();
    assert(S().tab==='tune'&&!d.querySelector('[data-pane="tune"]').hidden&&d.querySelector('[data-pane="play"]').hidden,'tabs switch panes');
    key('ArrowRight',{},d.querySelector('.tab[data-tab="tune"]'));
    assert(S().tab==='layers','arrow keys move between tabs');
    assert(d.querySelectorAll('[data-pane="tune"] input[type=range]').length>=17&&d.querySelectorAll('[data-pane="play"] input[type=range]').length>=26,'pose and tuning sliders are generated');

    // ---- auto-save per model ----
    click('btnPause');
    const setValue=(key,n,commit=true)=>{const input=$('p_'+key).parentElement.querySelector('.val');input.value=String(n);input.dispatchEvent(new w.Event('input'));if(commit)input.dispatchEvent(new w.Event('change'));};
    setValue('angleX',0.42);setValue('physAmp',1.25);
    const opacity=d.querySelector('.layer-card input[type=number]');opacity.value='0.65';opacity.dispatchEvent(new w.Event('input'));opacity.dispatchEvent(new w.Event('change'));
    const visible=d.querySelector('.layer-card input[type=checkbox]');visible.click();
    const storeKey='anime25d.settings.'+S().modelId;
    await wait(()=>h.memory.has(storeKey)&&JSON.parse(h.memory.get(storeKey)).params.physAmp===1.25,'auto-save');
    assert(true,'changes are saved automatically in the browser');
    select($('fileInput'),file);await wait(()=>S().layers>0&&$('drop').classList.contains('hidden')&&$('p_physAmp').value==='1.25','reopen');
    assert($('p_angleX').value==='0.42'&&!d.querySelector('.layer-card input[type=checkbox]').checked&&d.querySelector('.layer-card input[type=number]').value==='0.65','reopening the PSD restores parameters and layer properties');
    click('btnPause');
    click('btnExportSettings');const json=h.blobs.at(-1);assert(json.type==='application/json'&&JSON.parse(await json.text()).version===2,'settings file export (version 2)');
    select($('settingsInput'),new w.File([await json.text()],'settings.json'));await wait(()=>$('appStatus').textContent.includes('설정 파일을 불러왔습니다'),'settings import');
    $('appStatus').textContent='';
    select($('fileInput'),new w.File([await json.text()],'dropped.rig.json'));await wait(()=>$('appStatus').textContent.includes('설정 파일을 불러왔습니다'),'JSON through the PSD picker');
    assert(true,'a settings file can be opened like a PSD');

    // ---- undo / redo ----
    click('btnPause');
    setValue('angleX',0.1);setValue('angleX',0.3);
    key('z',{ctrlKey:true});assert(S().params.angleX===0.1,'Ctrl+Z undoes a parameter change');
    key('z',{ctrlKey:true,shiftKey:true});assert(S().params.angleX===0.3,'Ctrl+Shift+Z redoes it');
    click('btnUndo');assert(Math.abs(S().params.angleX-0.1)<1e-9&&!$('btnRedo').disabled,'toolbar undo button');
    click('btnRedo');

    // ---- keyboard: expressions ----
    key('2');assert(S().activePreset==='smile'&&d.querySelector('[data-preset="smile"]').classList.contains('active'),'key 2 applies the smile expression');
    key('2');assert(S().activePreset===null,'pressing it again clears it');
    key('6');key('0');assert(S().activePreset===null,'key 0 clears an expression');
    key('3');key('3',{repeat:true});key('3',{repeat:true});assert(S().activePreset==='usume','holding an expression key does not toggle it repeatedly');key('0');

    // ---- anchor editing ----
    key('e');await settle();
    assert(S().anchorMode&&d.querySelectorAll('#overlay .handle').length>=6,'E enters anchor mode with handles');
    const handle=d.querySelector('#overlay .handle[data-key="eyeL"]');
    key('ArrowRight',{shiftKey:true},handle);
    assert(S().anchors.eyeL&&S().anchors.eyeL.dx===10,'Shift+Arrow nudges an anchor by 10px');
    const closeHandle=d.querySelector('#overlay .handle[data-key="eyeRClose"]');key('ArrowLeft',{},closeHandle);key('ArrowDown',{},closeHandle);
    assert(S().anchors.eyeRClose&&S().anchors.eyeRClose.dy===1&&S().anchors.eyeRClose.dx===undefined,'closing-line handle only moves vertically');
    key('Escape');assert(!S().anchorMode,'Esc leaves anchor mode');
    click('btnExportSettings');const withAnchors=JSON.parse(await h.blobs.at(-1).text());
    assert(withAnchors.anchors.eyeL.dx===10,'anchors are saved in the settings');
    key('z',{ctrlKey:true});key('z',{ctrlKey:true});key('z',{ctrlKey:true});
    assert(!S().anchors.eyeL,'anchor edits can be undone');
    click('btnResetAnchors');

    // ---- preview zoom & background ----
    const stageEl=$('stage'),rect=stageEl.getBoundingClientRect();
    stageEl.dispatchEvent(new w.WheelEvent('wheel',{deltaY:-400,clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2,bubbles:true,cancelable:true}));
    assert(S().view.z>1.5&&/%$/.test($('btnZoom').textContent),'wheel zooms the preview');
    key('f');assert(S().view.z===1&&$('btnZoom').textContent==='전체','F fits the preview again');
    key('b');assert(S().background==='green'&&$('stage').classList.contains('green'),'B changes the preview background');
    click('btnBg');click('btnBg');assert(S().background==='checker','the background button cycles back');

    // ---- capsule bundle export ----
    {const n=h.blobs.length;click('btnExportBundle');await wait(()=>h.blobs.length>n&&h.blobs.at(-1).type==='application/zip','bundle export',30000);
      const zip=new Uint8Array(await h.blobs.at(-1).arrayBuffer());
      assert(zip[0]===0x50&&zip[1]===0x4b&&new TextDecoder().decode(zip).includes('rig.json'),'「캡슐 모델 내보내기」 produces a ZIP with rig.json');}

    // ---- rendering: iris clipping (read the preview canvas) ----
    click('btnResetAll');click('btnPause');
    for(const [k,n] of [['eyeOpenL',1],['eyeOpenR',1],['eyeX',0],['eyeY',0],['angleY',0],['angleZ',0],['body',0]])setValue(k,n,false);
    const canvas=document.createElement('canvas');canvas.width=128;canvas.height=128;const ctx=canvas.getContext('2d');
    async function pixels(){await new Promise(r=>w.requestAnimationFrame(()=>w.requestAnimationFrame(r)));ctx.clearRect(0,0,128,128);ctx.drawImage($('cv'),0,0);return ctx.getImageData(0,0,128,128).data;}
    const count=data=>{let red=0,blue=0;for(let i=0;i<data.length;i+=4){if(data[i]>240&&data[i+1]<30&&data[i+2]<30)red++;if(data[i]<30&&data[i+1]<30&&data[i+2]>240)blue++;}return {red,blue};};
    const first=await pixels();
    assert(first[3]===0&&first.some((v,i)=>i%4===3&&v>0),'preview has a transparent background and visible pixels');
    // Move both nearly-transparent eye whites after the irises. Their geometry
    // must still clip the irises, even though they have not been painted yet.
    const findCard=name=>[...d.querySelectorAll('.layer-card')].find(c=>c.querySelector('.layer-name').textContent===name&&c.querySelector('.layer-role').textContent.includes(name.endsWith('_2')?'오른쪽':'왼쪽'));
    for(const name of ['eyewhite','eyewhite_2']){
      let card=findCard(name);while(card!==$('layers').lastElementChild){card.querySelectorAll('.ord')[1].click();card=findCard(name);}
      const o=card.querySelector('input[type=number]');o.value='0.05';o.dispatchEvent(new w.Event('input'));
    }
    const reordered=count(await pixels());
    assert(reordered.red>0&&reordered.blue>0,'both iris masks work when eye whites are painted later');
    for(const name of ['eyewhite','eyewhite_2'])findCard(name).querySelector('input[type=checkbox]').click();
    const hiddenWhites=count(await pixels());
    assert(hiddenWhites.red>0&&hiddenWhites.blue>0,'irises stay visible (and clipped) when the eye whites are hidden');
    click('btnPause');

    // ---- robustness ----
    select($('fileInput'),new w.File(['bad'],'broken.psd'));
    await wait(()=>$('appStatus').classList.contains('error'),'invalid PSD error');
    assert($('modelName').textContent==='test.psd'&&$('drop').classList.contains('hidden'),'an invalid PSD keeps the current model');
    select($('fileInput'),file);click('btnCancelLoad');await settle();
    assert($('appStatus').textContent.includes('중지')&&$('drop').classList.contains('hidden'),'cancel keeps the current model');
    const gl=$('cv').getContext('webgl');assert(gl.getError()===gl.NO_ERROR,'rendering has no WebGL errors');
    click('tgBlink');click('tgRand');click('tgIdle');click('btnPause');   // keep the eyes open and still for the pixel checks below
    const contextExtension=gl.getExtension('WEBGL_lose_context');
    if(contextExtension){
      contextExtension.loseContext();await wait(()=>$('appStatus').textContent.includes('복구를 기다립니다'),'context loss');
      contextExtension.restoreContext();await wait(()=>$('appStatus').textContent==='그리기를 복구했습니다','context restoration');
      await settle(100);
      assert(!$('btnExportBundle').disabled&&gl.getError()===gl.NO_ERROR,'WebGL context restoration rebuilds a usable model');
      const restored=count(await pixels());
      assert(restored.red>0&&restored.blue>0,'iris masks work after context restoration');
    }
    key('?');assert($('helpOverlay').classList.contains('show')&&$('shortcutTable').querySelectorAll('tr').length>=10,'? opens the help with shortcuts');
    key('Escape');assert(!$('helpOverlay').classList.contains('show'),'Esc closes it');
    frame.style.width='390px';frame.style.height='844px';await settle(100);
    assert(d.documentElement.clientWidth===390&&d.documentElement.scrollWidth<=390&&w.getComputedStyle($('main')).flexDirection==='column','390px layout has no horizontal overflow');
    assert(h.errors.length===0,'no runtime errors: '+h.errors.join(', '));
    result.textContent+='ALL PASSED ('+passed+')';
  }catch(err){result.textContent+='FAIL '+err.stack;}finally{document.getElementById('run').disabled=false;}
});
