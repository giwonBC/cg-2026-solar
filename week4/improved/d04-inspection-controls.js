/* [개선] 수평 유지 회전(turntable) 컨트롤.
   기본 버전의 트랙볼은 드래그 방향이 조금만 비스듬해도 화면이 기울어졌습니다(불편 1).
   여기서는 회전을 두 각도로만 표현합니다.
     yaw   : 세계의 위쪽(+y) 축을 기준으로 좌우로 돈다
     pitch : 카메라의 가로축을 기준으로 위아래로 기울인다 (범위를 제한)
   두 축 모두 화면을 옆으로 눕히지 않으므로 건물의 위쪽이 항상 화면 위쪽에 남습니다.
   viewer 와 student 코드가 그대로 쓸 수 있도록 state.rotation(쿼터니언)도 함께 갱신합니다. */
window.InspectionControls = function(canvas) {
  const normalize=v=>{const n=Math.hypot(...v)||1;return v.map(x=>x/n);};
  const mul=(a,b)=>[
    a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1],
    a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0],
    a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3],
    a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2]];
  const rotate=(q,v)=>mul(mul(q,[...v,0]),[-q[0],-q[1],-q[2],q[3]]).slice(0,3);

  // pitch 범위: 위에서 거의 수직으로 내려다보기(-1.5) ~ 살짝 올려다보기(+0.35)
  const PITCH_MIN=-1.5,PITCH_MAX=.35;
  const state={target:[3,3,0],distance:30,yaw:.6,pitch:-.44,rotation:[0,0,0,1],fov:45,actions:0,
    lockRotation:false,   // 직교 뷰에서는 회전을 잠가 축 정렬을 유지한다
    onInput:null};        // 사용자가 직접 조작하면 student 코드에 알린다 (이동 애니메이션 취소용)

  // yaw·pitch → 쿼터니언. 먼저 pitch(x축), 그다음 yaw(y축)를 적용한다.
  function sync(){
    state.pitch=Math.max(PITCH_MIN,Math.min(PITCH_MAX,state.pitch));
    const qy=[0,Math.sin(state.yaw/2),0,Math.cos(state.yaw/2)];
    const qx=[Math.sin(state.pitch/2),0,0,Math.cos(state.pitch/2)];
    state.rotation=normalize(mul(qy,qx));
  }
  // 기본 버전과 같은 전체 보기 시점 (yaw 0.6, pitch -0.44 는 기본 버전 쿼터니언과 같은 각도)
  function home(){state.target=[3,3,0];state.distance=30;state.yaw=.6;state.pitch=-.44;state.fov=45;sync();}
  home();

  const input=kind=>{state.actions++;if(state.onInput)state.onInput(kind);};
  let drag=null;
  canvas.style.touchAction='none';
  canvas.addEventListener('contextmenu',e=>e.preventDefault());
  canvas.addEventListener('pointerdown',e=>{
    if(drag || ![0,2].includes(e.button))return;
    const pan=e.shiftKey||e.button===2||state.lockRotation;   // 잠금 중에는 드래그가 평행 이동이 된다
    drag={id:e.pointerId,x:e.clientX,y:e.clientY,yaw:state.yaw,pitch:state.pitch,target:[...state.target],pan};
    input(pan?'pan':'rotate');canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove',e=>{
    if(!drag || drag.id!==e.pointerId)return;
    const r=canvas.getBoundingClientRect(),dx=e.clientX-drag.x,dy=e.clientY-drag.y;
    if(drag.pan){
      const unit=2*state.distance*Math.tan(state.fov*Math.PI/360)/r.height;
      const right=rotate(state.rotation,[1,0,0]),up=rotate(state.rotation,[0,1,0]);
      state.target=drag.target.map((v,i)=>v-dx*unit*right[i]+dy*unit*up[i]);
    }else{
      // 화면 높이만큼 끌면 약 135° — 가로 드래그는 좌우 회전만, 세로 드래그는 위아래 기울기만
      const k=.75*Math.PI/r.height;
      state.yaw=drag.yaw-dx*k;
      state.pitch=drag.pitch-dy*k;
      sync();
    }
  });
  for(const event of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(event,e=>{if(drag?.id===e.pointerId)drag=null;});
  canvas.addEventListener('wheel',e=>{e.preventDefault();state.distance=Math.max(.12,Math.min(100,state.distance*Math.exp(e.deltaY*.001)));input('zoom');},{passive:false});
  canvas.addEventListener('keydown',e=>{
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','-','Home'].includes(e.key))return;e.preventDefault();
    input(e.key==='Home'?'home':'key');
    if(e.key==='Home'){home();return;}
    if(e.key==='+')state.distance=Math.max(.12,state.distance/1.12);
    else if(e.key==='-')state.distance=Math.min(100,state.distance*1.12);
    else if(!state.lockRotation){
      if(e.key==='ArrowLeft')state.yaw+=.12;
      if(e.key==='ArrowRight')state.yaw-=.12;
      if(e.key==='ArrowUp')state.pitch+=.08;
      if(e.key==='ArrowDown')state.pitch-=.08;
      sync();
    }
  });
  function camera(){const offset=rotate(state.rotation,[0,0,state.distance]);return {eye:state.target.map((v,i)=>v+offset[i]),target:[...state.target],up:rotate(state.rotation,[0,1,0])};}
  return {state,home,camera,sync,rotate};
};
