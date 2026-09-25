(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  root.HitPlayEngine=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const HOME='H';
  const BASE_NAMES={1:'一塁',2:'二塁',3:'三塁',H:'本塁'};
  const ORIGIN_NAMES={batter:'打者走者',1:'元一塁走者',2:'元二塁走者',3:'元三塁走者'};
  const COMMENTARY_NAMES={batter:'打者走者',1:'一塁走者',2:'二塁走者',3:'三塁走者'};
  const CAUSE_NAMES={none:'なし',passed:'後逸',throwing:'悪送球',throw:'送球間',rundown:'挟殺'};

  function clone(value){return JSON.parse(JSON.stringify(value))}
  function baseName(base){return BASE_NAMES[base]||String(base)}
  function runnerName(runner,withCurrent=false){
    const name=ORIGIN_NAMES[runner.origin]||'走者';
    return withCurrent&&runner.status==='active'?name+'・現在'+baseName(runner.currentBase):name;
  }
  function commentaryName(runner){return COMMENTARY_NAMES[runner.origin]||'走者'}
  function nextBase(base){return base===1?2:base===2?3:base===3?HOME:null}
  function intervalFor(base){return base===1?'betweenFirstAndSecond':base===2?'betweenSecondAndThird':base===3?'betweenThirdAndHome':''}
  function intervalName(interval){return {betweenFirstAndSecond:'一・二塁間',betweenSecondAndThird:'二・三塁間',betweenThirdAndHome:'三・本塁間'}[interval]||''}
  function isScored(runner){return runner.status==='scored'}
  function isOut(runner){return runner.status==='out'}
  function activeRunners(flow){return flow.runners.filter(r=>r.status==='active')}
  function occupiedBases(flow,exceptId){return new Set(activeRunners(flow).filter(r=>r.id!==exceptId).map(r=>r.currentBase))}
  function runnerById(flow,id){return flow.runners.find(r=>r.id===id)}
  function totalOuts(flow){return flow.startOuts+flow.outs}
  function stopAtThreeOuts(flow){
    if(totalOuts(flow)<3)return false;
    flow.runners.forEach(r=>{if(r.status==='pending')r.status='skipped'});
    flow.phase='complete';
    flow.endedByThreeOuts=true;
    return true;
  }
  function destinationCode(kind,destination){return kind+':'+destination}
  function option(kind,destination,label){return {code:destinationCode(kind,destination),kind,destination,label}}

  function create(config){
    const hitBase=Number(config.hitBase);
    if(![1,2,3].includes(hitBase))throw new Error('invalid hit base');
    const originals=(config.runners||[]).filter(r=>[1,2,3].includes(Number(r.originBase))).map(r=>({
      id:'r'+Number(r.originBase),origin:Number(r.originBase),playerIndex:r.playerIndex,currentBase:Number(r.originBase),finalDestination:null,status:'pending',outLocation:null,outReason:null,scorePhase:null,events:[]
    })).sort((a,b)=>b.origin-a.origin);
    const batter={id:'batter',origin:'batter',playerIndex:config.batterPlayerIndex,currentBase:hitBase,finalDestination:hitBase,status:'active',outLocation:null,outReason:null,scorePhase:null,events:[]};
    const flow={
      hitBase,key:config.key||'center',label:config.label||({1:'ヒット',2:'二塁打',3:'三塁打'}[hitBase]),startOuts:Math.max(0,Number(config.outs)||0),outs:0,error:false,errorType:null,
      runners:[...originals,batter],normalOrder:originals.map(r=>r.id),normalIndex:0,extraOrder:[],extraIndex:0,additional:null,rundownRunnerId:null,rundownInterval:null,
      phase:originals.length?'normal':'additional-select',events:[],endedByThreeOuts:false,automaticAward:!!config.automaticAward
    };
    if(flow.automaticAward){
      originals.forEach(r=>{
        const destination=r.origin>=2?HOME:r.origin+2;
        applyDestination(flow,r,'safe',destination,'normal');
      });
      flow.phase='complete';
    }
    return flow;
  }

  function nextNormalRunner(flow){return runnerById(flow,flow.normalOrder[flow.normalIndex])||null}
  function leadBlocker(flow,runner){
    return activeRunners(flow)
      .filter(r=>r.id!==runner.id&&!(runner.status==='pending'&&r.id==='batter')&&Number(r.currentBase)>Number(runner.currentBase))
      .sort((a,b)=>a.currentBase-b.currentBase)[0]||null;
  }
  function canReach(flow,runner,destination){
    if(destination===HOME)return !leadBlocker(flow,runner);
    if(occupiedBases(flow,runner.id).has(destination))return false;
    const blocker=leadBlocker(flow,runner);
    return !blocker||destination<blocker.currentBase;
  }
  function normalDestinations(flow,runner){
    if(flow.hitBase===3)return [HOME];
    if(flow.hitBase===2)return runner.origin===3?[HOME]:[3,HOME];
    return runner.origin===1?[2,3,HOME]:runner.origin===2?[3,HOME]:[HOME];
  }
  function normalOptions(flow,runnerId){
    const runner=runnerById(flow,runnerId);
    if(!runner||runner.status!=='pending')return [];
    const allDestinations=normalDestinations(flow,runner);
    const destinations=allDestinations.filter(d=>canReach(flow,runner,d));
    const blocker=leadBlocker(flow,runner);
    const outDestinations=allDestinations.filter(d=>canReach(flow,runner,d)||(blocker&&d===blocker.currentBase));
    const options=[];
    destinations.forEach(d=>options.push(option('safe',d,d===HOME?'本塁生還':baseName(d)+'到達')));
    outDestinations.forEach(d=>options.push(option('tagOut',d,baseName(d)+'タッチアウト')));
    return options;
  }
  function applyDestination(flow,runner,kind,destination,phase,cause){
    const before=runner.currentBase;
    if(kind==='stay'){
      runner.status='active';
      runner.finalDestination=before;
      return;
    }
    if(kind==='safe'){
      if(destination===HOME){runner.status='scored';runner.currentBase=null;runner.finalDestination=HOME;runner.scorePhase=phase}
      else{runner.status='active';runner.currentBase=Number(destination);runner.finalDestination=Number(destination)}
    }else if(kind==='tagOut'){
      runner.status='out';runner.currentBase=null;runner.finalDestination='OUT';runner.outLocation=destination===HOME?'home':String(destination);runner.outReason='tagOut';flow.outs++;
    }
    const who=commentaryName(runner);
    let text='';
    if(kind==='safe')text=destination===HOME?who+'が生還':who+'は'+baseName(destination)+'へ';
    if(kind==='tagOut')text=who+'は'+baseName(destination)+'を狙うも'+baseName(destination)+'タッチアウト';
    if(phase==='additional'&&text)text=(cause==='throw'?'送球間に':CAUSE_NAMES[cause]+'の間に')+text;
    if(text){flow.events.push(text);runner.events.push({phase,cause:cause||null,kind,destination,text})}
  }
  function parseCode(code){const parts=String(code).split(':');return {kind:parts[0],destination:parts[1]===HOME?HOME:Number(parts[1])}}
  function applyNormal(flow,runnerId,code){
    if(flow.phase!=='normal')throw new Error('normal phase is closed');
    const runner=nextNormalRunner(flow);
    if(!runner||runner.id!==runnerId)throw new Error('runner order mismatch');
    const allowed=normalOptions(flow,runnerId).find(o=>o.code===code);
    if(!allowed)throw new Error('invalid normal result');
    applyDestination(flow,runner,allowed.kind,allowed.destination,'normal');
    flow.normalIndex++;
    if(stopAtThreeOuts(flow))return flow;
    flow.phase=flow.normalIndex>=flow.normalOrder.length?'additional-select':'normal';
    return flow;
  }

  function selectAdditional(flow,cause){
    if(flow.phase!=='additional-select')throw new Error('additional play is unavailable');
    if(!Object.prototype.hasOwnProperty.call(CAUSE_NAMES,cause))throw new Error('invalid additional play');
    flow.additional=cause;
    if(cause==='none'){flow.phase='complete';return flow}
    if(cause==='rundown'){flow.phase='rundown-runner';return flow}
    if(cause==='passed'||cause==='throwing'){flow.error=true;flow.errorType=cause}
    flow.extraOrder=activeRunners(flow).sort((a,b)=>b.currentBase-a.currentBase).map(r=>r.id);
    flow.extraIndex=0;
    flow.phase=flow.extraOrder.length?'additional-runner':'complete';
    return flow;
  }
  function nextExtraRunner(flow){return runnerById(flow,flow.extraOrder[flow.extraIndex])||null}
  function extraOptions(flow,runnerId){
    const runner=runnerById(flow,runnerId);
    if(!runner||runner.status!=='active')return [];
    const options=[option('stay',runner.currentBase,'そのまま'+baseName(runner.currentBase))];
    const allDestinations=[];
    for(let b=runner.currentBase+1;b<=3;b++)allDestinations.push(b);
    allDestinations.push(HOME);
    const destinations=allDestinations.filter(d=>canReach(flow,runner,d));
    const blocker=leadBlocker(flow,runner);
    const outDestinations=allDestinations.filter(d=>canReach(flow,runner,d)||(blocker&&d===blocker.currentBase));
    destinations.forEach(d=>options.push(option('safe',d,d===HOME?'本塁生還':baseName(d)+'到達')));
    outDestinations.forEach(d=>options.push(option('tagOut',d,baseName(d)+'タッチアウト')));
    return options;
  }
  function applyExtra(flow,runnerId,code){
    if(flow.phase!=='additional-runner')throw new Error('additional runner phase is closed');
    const runner=nextExtraRunner(flow);
    if(!runner||runner.id!==runnerId)throw new Error('runner order mismatch');
    const allowed=extraOptions(flow,runnerId).find(o=>o.code===code);
    if(!allowed)throw new Error('invalid additional result');
    applyDestination(flow,runner,allowed.kind,allowed.destination,'additional',flow.additional);
    flow.extraIndex++;
    if(stopAtThreeOuts(flow))return flow;
    flow.phase=flow.extraIndex>=flow.extraOrder.length?'complete':'additional-runner';
    return flow;
  }

  function rundownTargets(flow){return activeRunners(flow).sort((a,b)=>b.currentBase-a.currentBase)}
  function selectRundownRunner(flow,runnerId){
    if(flow.phase!=='rundown-runner')throw new Error('rundown runner phase is closed');
    const runner=rundownTargets(flow).find(r=>r.id===runnerId);
    if(!runner)throw new Error('invalid rundown runner');
    flow.rundownRunnerId=runnerId;
    flow.phase='rundown-interval';
    return flow;
  }
  function rundownIntervals(flow){
    const runner=runnerById(flow,flow.rundownRunnerId);
    if(!runner||runner.status!=='active')return [];
    const interval=intervalFor(runner.currentBase);
    return interval?[{code:interval,label:intervalName(interval)}]:[];
  }
  function selectRundownInterval(flow,interval){
    if(flow.phase!=='rundown-interval'||!rundownIntervals(flow).some(x=>x.code===interval))throw new Error('invalid rundown interval');
    flow.rundownInterval=interval;
    flow.phase='rundown-result';
    return flow;
  }
  function rundownResultOptions(flow){
    const runner=runnerById(flow,flow.rundownRunnerId);
    if(!runner)return [];
    const next=nextBase(runner.currentBase),nextText=next===HOME?'本塁生還':baseName(next)+'到達',canAdvance=canReach(flow,runner,next);
    const options=[{code:'return',label:'元の塁へ帰塁'}];
    if(canAdvance)options.push({code:'advance',label:nextText});
    options.push({code:'out',label:'挟殺アウト'},{code:'throwing-return',label:'悪送球で帰塁'});
    if(canAdvance)options.push({code:'throwing-advance',label:'悪送球で'+nextText});
    options.push({code:'passed-return',label:'後逸で帰塁'});
    if(canAdvance)options.push({code:'passed-advance',label:'後逸で'+nextText});
    return options;
  }
  function applyRundownResult(flow,code){
    if(flow.phase!=='rundown-result'||!rundownResultOptions(flow).some(x=>x.code===code))throw new Error('invalid rundown result');
    const runner=runnerById(flow,flow.rundownRunnerId),from=runner.currentBase,next=nextBase(from),who=commentaryName(runner),where=intervalName(flow.rundownInterval);
    if(code==='out'){
      runner.status='out';runner.currentBase=null;runner.finalDestination='OUT';runner.outLocation=flow.rundownInterval;runner.outReason='rundown';flow.outs++;
      flow.events.push(who+'は'+baseName(next)+'を狙うも、'+where+'で挟殺アウト');
    }else{
      const isAdvance=/-advance$/.test(code)||code==='advance';
      const isError=/^(throwing|passed)-/.test(code);
      if(isError){flow.error=true;flow.errorType=code.indexOf('throwing')===0?'throwing':'passed'}
      if(isAdvance){
        if(next===HOME){runner.status='scored';runner.currentBase=null;runner.finalDestination=HOME;runner.scorePhase='additional'}
        else{runner.currentBase=next;runner.finalDestination=next}
      }
      const cause=isError?(flow.errorType==='throwing'?'悪送球':'後逸')+'で':'';
      flow.events.push(who+'は'+where+'で挟まれるも、'+cause+(isAdvance?(next===HOME?'本塁生還':baseName(next)+'到達'):baseName(from)+'へ帰塁'));
    }
    stopAtThreeOuts(flow);
    flow.phase='complete';
    return flow;
  }

  function result(flow){
    if(flow.phase!=='complete')throw new Error('play is not complete');
    const runs=flow.runners.filter(isScored).length;
    const rbi=flow.runners.filter(r=>isScored(r)&&r.scorePhase==='normal').length;
    const active=activeRunners(flow).map(r=>({id:r.id,origin:r.origin,playerIndex:r.playerIndex,currentBase:r.currentBase}));
    const detail={
      hitType:flow.hitBase===1?'single':flow.hitBase===2?'double':'triple',hitBase:flow.hitBase,label:flow.label,key:flow.key,additionalPlay:flow.additional||'none',
      runs,rbi,outs:flow.outs,error:flow.error,errorType:flow.errorType,endedByThreeOuts:flow.endedByThreeOuts,
      runners:flow.runners.map(r=>({id:r.id,runnerType:r.origin==='batter'?'batterRunner':'originalBase'+r.origin,originBase:r.origin==='batter'?null:r.origin,currentBase:r.currentBase,finalDestination:r.finalDestination,isOut:isOut(r),outLocation:r.outLocation,outReason:r.outReason,status:r.status,playerIndex:r.playerIndex}))
    };
    return {runs,rbi,outs:flow.outs,error:flow.error,errorType:flow.errorType,active,commentary:[flow.label,...flow.events].filter(Boolean).join('。'),detail};
  }

  return {HOME,CAUSE_NAMES,create,clone,baseName,runnerName,commentaryName,nextNormalRunner,normalOptions,applyNormal,selectAdditional,nextExtraRunner,extraOptions,applyExtra,rundownTargets,selectRundownRunner,rundownIntervals,selectRundownInterval,rundownResultOptions,applyRundownResult,result,totalOuts};
});
