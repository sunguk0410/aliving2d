'use strict';
importScripts('ag-psd.min.js','rigger.js','runtime.js');
agPsd.initializeCanvas(undefined,(width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4)}));
onmessage = function(ev) {
  try {
    const {buffer,generic}=ev.data;
    RigRuntime.validateHeader(buffer);
    postMessage({progress:'레이어 구성 확인 중…'});
    const id=RigRuntime.fingerprint(buffer);
    const options={useImageData:true,skipThumbnail:true,skipCompositeImageData:true};
    Rigger.validatePsd(agPsd.readPsd(new Uint8Array(buffer),{...options,skipLayerImageData:true}));
    postMessage({progress:'이미지 푸는 중…'});
    const psd=agPsd.readPsd(new Uint8Array(buffer),{...options,skipCompositeImageData:false});
    postMessage({progress:'잡티 정리 중…'});
    const pre=Rigger.cleanPsdLayers(psd);
    postMessage({progress:'파츠와 기준점 만드는 중…'});
    const rig=Rigger.buildRig(psd,{generic});
    const transfers=new Set();
    function collect(v) {
      if(!v || typeof v!=='object')return;
      if(ArrayBuffer.isView(v)){transfers.add(v.buffer);return;}
      for(const x of Object.values(v))collect(x);
    }
    collect(psd); collect(rig);
    postMessage({psd,pre,rig,id},[...transfers]);
  } catch(err) { postMessage({error:err.message || String(err)}); }
};
