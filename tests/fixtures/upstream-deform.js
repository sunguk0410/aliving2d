// Frozen copy of fadeAlpha / deform / updateSprings from Anime2.5DRig lib/app.js at 7ddbd99 (MIT).
// Reference for tests/equivalence.test.js: engine/core.js must match it with all EXTENSIONS at their defaults.
// Do not edit.
function fadeAlpha(L,e,alt){
  if(!L.fade)return 1;
  if(L.fade==='eyeOpen'){const v=L.side==='L'?e.eyeOpenL:e.eyeOpenR;return smooth((v-(0.10+e.eyeEase*0.45))/0.15);}
  if(L.fade==='eyeClose'||L.fade==='eyeClose2'){
    const alternate=blinkVariant===2&&alt[L.side];
    if((L.fade==='eyeClose2')!==alternate)return 0;
    const v=L.side==='L'?e.eyeOpenL:e.eyeOpenR;return 1-smooth((v-(0.10+e.eyeEase*0.45))/0.15);
  }
  if(L.fade==='mouthOpen')return smooth((e.mouthOpen-(0.05+e.mouthEase*0.35))/0.12);
  if(L.fade==='mouthClose')return 1-smooth((e.mouthOpen-(0.05+e.mouthEase*0.35))/0.12);
  return 1;
}

const FRONTISH={'front hair':1,'side hair':1,'ahoge':1};
function deform(L,e){
  const b=L.base,o=L.cur,n=b.length;
  const isHead=L.group==='head';
  const az=e.angleZ*0.07,cz=Math.cos(az),sz=Math.sin(az);
  const ab=e.body*0.028,cb=Math.cos(ab),sb=Math.sin(ab);
  const bn=L.bn,eyeSide=L.side,EA=eyeSide==='L'?A.eyeL:(eyeSide==='R'?A.eyeR:null);
  const vOpen=eyeSide==='L'?e.eyeOpenL:e.eyeOpenR;
  const mo=e.mouthOpen,mHalfW=(A.mouth.x1-A.mouth.x0)/2;
  const nS=L.strands?L.strands.length:0;
  const bcx=L.x+L.w/2,bcy=L.y+L.h/2;
  const kind=L.phys==='sway'?'acc':FRONTISH[bn]?'fh':'bh';
  const physOn=nS&&auto.phys&&L.su;
  const ampK=kind==='acc'?e.accAmp*1.4:kind==='fh'?e.fhAmp:e.physAmp;
  const softK=kind==='acc'?0.8:kind==='fh'?e.fhSoft:e.soft;
  const powA=kind==='acc'?1.2:kind==='fh'?1.8:2.1;
  for(let k=0;k<n;k+=2){
    let x=b[k],y=b[k+1];
    const vi=k>>1;
    // --- closed-eye / mouth scale ---
    if(EA&&(bn==='eye_close'||bn==='eye_close2')){
      const sE=eyeSide==='L'?e.eyeScaleL:e.eyeScaleR;
      if(sE!==1){const cxE=(EA.x0+EA.x1)/2,cyE=(EA.y0+EA.y1)/2;x=cxE+(x-cxE)*sE;y=cyE+(y-cyE)*sE;}
    }
    if(bn==='mouth_open'||bn==='mouth_close'){
      const sM=e.mouthScale;
      if(sM!==1){x=A.mouth.cx+(x-A.mouth.cx)*sM;y=A.mouth.cy+(y-A.mouth.cy)*sM;}
    }
    // --- local features ---
    if(L.fade==='eyeOpen'&&EA){
      if(bn==='irides'){
        const isc=e.irisScale,ibx=e.irisBounceX||1,iby=e.irisBounceY||1;
        x=EA.icx+(x-EA.icx)*isc*ibx;y=EA.icy+(y-EA.icy)*isc*iby;
        x+=e.eyeX*11*FS;y+=e.eyeY*6*FS;
        const tl=smooth((0.32-vOpen)/0.32);   // iris stays round until nearly closed
        y=EA.closeY+(y-EA.closeY)*(1-0.80*tl);
      }else{
        y=EA.closeY+(y-EA.closeY)*(1-0.85*(1-vOpen));   // lid compression
      }
    }
    if((L.fade==='eyeClose'||L.fade==='eyeClose2')&&EA){
      y-=vOpen*3;y+=e.eyeCY*14*FS;
      const thE=e.eyeCAng*0.3*(eyeSide==='L'?1:-1);
      if(thE){const ct=Math.cos(thE),st=Math.sin(thE),rx=x-bcx,ry=y-bcy;x=bcx+rx*ct-ry*st;y=bcy+rx*st+ry*ct;}
    }
    if(bn==='eyebrow'){
      y+=(-e.brow*9+(1-vOpen)*3.5)*FS;
      const th=(eyeSide==='L'?(e.browAngL+e.browAngSym):(e.browAngR-e.browAngSym))*0.30;
      if(th){const ct=Math.cos(th),st=Math.sin(th),rx=x-bcx,ry=y-bcy;x=bcx+rx*ct-ry*st;y=bcy+rx*st+ry*ct;}
    }
    if(L.fade==='mouthOpen'){
      y=A.mouth.y0+(y-A.mouth.y0)*(0.5+0.5*mo);
      const q=Math.pow(Math.abs(x-A.mouth.cx)/(mHalfW+4),1.5);
      y-=e.mouthForm*6*FS*(q-0.35);
    }
    if(L.fade==='mouthClose'){
      y+=e.mouthCY*14*FS;
      const thM=e.mouthCAng*0.35;
      if(thM){const ct=Math.cos(thM),st=Math.sin(thM),rx=x-A.mouth.cx,ry=y-A.mouth.cy;x=A.mouth.cx+rx*ct-ry*st;y=A.mouth.cy+rx*st+ry*ct;}
    }
    if(bn==='face'&&y>A.mouth.cy)y+=mo*6*FS*smooth((y-A.mouth.cy)/Math.max(1,A.face.y1-A.mouth.cy));
    // --- head transform ---
    let hw=isHead?1:(L.group==='body'?0.16:0);   // body subtly follows head XYZ
    if(bn==='neck')hw=0.55*smooth((A.neckBottom-y)/Math.max(1,A.neckBottom-A.neckTop));
    if(hw>0){
      const rx=x-NP.cx,ry=y-NP.cy,rx2=rx*cz-ry*sz,ry2=rx*sz+ry*cz;
      x+=(rx2-rx)*hw;y+=(ry2-ry)*hw;
      const dd=L.depth;
      x+=hw*FS*(e.angleX*(14+40*(dd-1))+e.angleX*(NP.cy-y)*0.028);
      y+=hw*FS*(-e.angleY*(9+30*(dd-1))-e.angleY*(dd-1)*(y-FC.y)*0.05);
    }
    // --- breathing ---
    y-=(L.group==='body'?e.breath*2.0:e.breathHead*1.6)*FS;
    if(bn==='topwear'&&y<CHEST.cy)y-=e.breath*2.2*FS*smooth((CHEST.cy-y)/(CHEST.ry*2));   // shoulders rise
    if(bn==='topwear')x=NP.cx+(x-NP.cx)*(1+e.breath*0.003);
    // --- bust jiggle ---
    if(bn==='topwear'){
      const gx=(x-CHEST.cx)/CHEST.rx,gy=(y-(CHEST.cy+e.bustY*70*FS))/CHEST.ry;
      y+=bounce.dy*e.bust*Math.exp(-gx*gx-gy*gy);
    }
    // --- arms ---
    if(bn==='handwear'){
      const w=smooth((y-L.y)/L.h*1.15);
      y-=e.armY*30*FS*w;y+=e.armPos*40*FS;x+=e.armY*6*FS*w*(x<NP.cx?1:-1);
    }
    // --- bang blocks ---
    if(L.bw){const m=Math.pow(L.su[vi],1.4)*22*FS;x+=(e.bangL*L.bw[vi*3]+e.bangC*L.bw[vi*3+1]+e.bangR*L.bw[vi*3+2])*m;}
    // --- strand physics: stiff root, fluffy tips (front hair / accessories have their own params) ---
    if(physOn){
      const u=kind==='fh'?Math.min(1,L.su[vi]*1.6):L.su[vi];
      const amp=Math.pow(u,powA)*ampK,softMix=Math.min(1,Math.pow(u,1.2)*softK);
      let dx=0;
      for(let s=0;s<nS;s++){const w=L.sw[vi*nS+s];if(w<0.001)continue;const sp=L.spr[s];dx+=w*(sp.stiff.dx*(1-softMix)+sp.soft.dx*softMix);}
      x+=dx*amp;y+=Math.abs(dx)*amp*0.12;
    }
    o[k]=x;o[k+1]=y;
  }
  // --- body rotation (around bottom center) ---
  if(Math.abs(ab)>1e-4){
    for(let k=0;k<n;k+=2){const rx=o[k]-BP.cx,ry=o[k+1]-BP.cy;o[k]=BP.cx+rx*cb-ry*sb;o[k+1]=BP.cy+rx*sb+ry*cb;}
  }
}

function updateSprings(e,t,dt,wind){
  const headDX=(e.angleX*14+e.angleZ*0.07*(NP.cy-FC.y))*FS;
  const bodyDX=e.body*0.028*(BP.cy-NP.cy)*0.35+e.angleX*14*0.16*FS;
  for(const L of layers){
    if(!L.spr)continue;
    const base=L.group==='head'?headDX:bodyDX,windScale=L.phys==='sway'&&L.group!=='head'?2.5:1;
    for(const sp of L.spr){
      const w=wind?(1.8*Math.sin(t*0.8+sp.phase)+1.0*Math.sin(t*1.9+sp.phase*2.3))*windScale:0;
      const txv=base+w*FS;
      RT.spring(sp.stiff,txv,70,9,dt);sp.stiff.dx=-(sp.stiff.x-txv)*2.2;
      RT.spring(sp.soft,txv,16,1.3,dt);sp.soft.dx=-(sp.soft.x-txv)*3.0;
    }
  }
  const bustTgt=(e.breath*3.0-e.angleY*6.0+e.body*4.0)*FS;
  RT.spring(bounce,bustTgt,140,4.2,dt);bounce.dy=-(bounce.x-bustTgt)*3.0;
}
