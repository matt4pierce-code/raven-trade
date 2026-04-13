import { useState, useEffect, useRef, useCallback } from "react";

const STORAGE_KEY="raven-trade-permanent-v1";
const PAIRS=["BTC/USDT","ETH/USDT","SOL/USDT","BNB/USDT","XRP/USDT","DOGE/USDT","ADA/USDT","AVAX/USDT","LINK/USDT","LTC/USDT"];
const STARTING_CAP=1000;
const RISK_PER_TRADE=0.015;
const HARD_STOP=0.025;
const DAILY_TARGET=0.08;
const DAILY_LOSS_MAX=0.04;
const MAX_TRADES_DAY=3;
const CONSEC_LOSS_MAX=2;
const BB_PERIOD=20;
const BB_STD_DEV=2.5;
const POLL_MS=15000;

const CLR={green:"#00ff9d",red:"#ff6b6b",yel:"#ffd166",dim:"#3a3a3a",dark:"#0d1117",bg:"#060910",bdr:"#161e2e"};

async function loadSaved(){try{const r=await window.storage.get(STORAGE_KEY);return r?JSON.parse(r.value):null;}catch{return null;}}
async function savePersist(d){try{await window.storage.set(STORAGE_KEY,JSON.stringify(d));}catch{}}

function calcSMA(arr,n){const s=arr.slice(-n);return s.reduce((a,b)=>a+b,0)/s.length;}
function calcStd(arr,mean){return Math.sqrt(arr.reduce((s,v)=>s+Math.pow(v-mean,2),0)/arr.length);}
function calcRSI(prices,period=14){if(prices.length<period+1)return 50;let gains=0,losses=0;for(let i=prices.length-period;i<prices.length;i++){const d=prices[i]-prices[i-1];if(d>0)gains+=d;else losses-=d;}const g=gains/period,l=losses/period;return l===0?100:100-(100/(1+g/l));}
function calcMACD(prices){if(prices.length<26)return{macd:0,signal:0};const ema=(p,n)=>{const k=2/(n+1);return p.slice(-n).reduce((e,v)=>v*k+e*(1-k));};const macd=ema(prices,12)-ema(prices,26);return{macd,signal:macd*0.8};}

function analyzeSignal(pair,klines,ticker){
  if(!klines||klines.length<BB_PERIOD+2||!ticker)return null;
  const price=ticker.price;
  const sma=calcSMA(klines,BB_PERIOD);
  const std=Math.max(price*0.004,calcStd(klines.slice(-BB_PERIOD),sma));
  const upper=sma+BB_STD_DEV*std;
  const lower=sma-BB_STD_DEV*std;
  const rsi=calcRSI(klines);
  const{macd,signal}=calcMACD(klines);
  const atLower=price<=lower*1.005;
  const atUpper=price>=upper*0.995;
  if(!atLower&&!atUpper)return null;
  const why=[];let strength=0;let dir=null;
  if(atLower){dir="BUY";why.push("At Lower Band");strength+=3;if(rsi<32){why.push("RSI Oversold "+rsi.toFixed(0));strength+=3;}if(rsi<25){why.push("RSI Extreme");strength+=2;}if(macd>signal){why.push("MACD Cross Up");strength+=2;}}
  else{dir="SHORT";why.push("At Upper Band");strength+=3;if(rsi>68){why.push("RSI Overbought "+rsi.toFixed(0));strength+=3;}if(rsi>75){why.push("RSI Extreme");strength+=2;}if(macd<signal){why.push("MACD Cross Down");strength+=2;}}
  if(strength<5||why.length<2)return null;
  const potentialGain=Math.abs(sma-price)/price*100;
  const quality=Math.min(10,Math.round(strength*0.7+potentialGain*0.8));
  return{pair,price,dir,why,strength,quality,sma,upper,lower,rsi,macd,signal,targetPrice:sma,potentialGain,distFromMean:(price-sma)/sma*100,high24:ticker.high24,low24:ticker.low24,change24:ticker.change24};
}

const f2=n=>n?.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})??"—";
const usd=n=>"$"+f2(n);
const pct=n=>(n>=0?"+":"")+f2(n)+"%";

async function fetchWithFallback(url){
  const proxies=[`https://corsproxy.io/?${encodeURIComponent(url)}`,`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,url];
  for(const proxy of proxies){try{const res=await fetch(proxy,{signal:AbortSignal.timeout(8000)});if(res.ok)return await res.json();}catch(e){continue;}}
  return null;
}

async function loadAllData(klinesCache){
  const tickers={};const klines={...klinesCache};
  try{
    const data=await fetchWithFallback("https://data-api.binance.vision/api/v3/ticker/24hr");
    if(data&&Array.isArray(data)){
      data.forEach(t=>{
        const formatted=t.symbol.slice(0,-4)+"/USDT";
        if(PAIRS.includes(formatted)){
          tickers[formatted]={price:parseFloat(t.lastPrice),high24:parseFloat(t.highPrice),low24:parseFloat(t.lowPrice),change24:parseFloat(t.priceChangePercent)};
        }
      });
    }
  }catch(e){}
  for(const pair of PAIRS){
    if(!klines[pair]||klines[pair].length<BB_PERIOD+2){
      try{
        const sym=pair.replace("/","");
        const data=await fetchWithFallback(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=5m&limit=50`);
        if(data&&Array.isArray(data)){klines[pair]=data.map(k=>parseFloat(k[4]));}
      }catch(e){}
    }else if(tickers[pair]){
      klines[pair]=[...klines[pair].slice(1),tickers[pair].price];
    }
  }
  return{tickers,klines};
}

export default function App(){
  const [ready,setReady]=useState(false);
  const [tickers,setTickers]=useState({});
  const [klinesCache,setKlinesCache]=useState({});
  const [signals,setSignals]=useState([]);
  const [trade,setTrade]=useState(null);
  const [history,setHistory]=useState([]);
  const [dayLog,setDayLog]=useState([]);
  const [capital,setCapital]=useState(STARTING_CAP);
  const [dayPnL,setDayPnL]=useState(0);
  const [streak,setStreak]=useState(0);
  const [paused,setPaused]=useState(false);
  const [tab,setTab]=useState("trade");
  const [toast,setToast]=useState(null);
  const [saving,setSaving]=useState(false);
  const [apiStatus,setApiStatus]=useState("connecting");
  const [lastUpdate,setLastUpdate]=useState(null);
  const [notifStatus,setNotifStatus]=useState("unknown");
  const klinesCacheRef=useRef({});
  const tradeRef=useRef(null);
  const isFetching=useRef(false);

  // Keep tradeRef in sync so fetchAndUpdate always has latest trade
  useEffect(()=>{ tradeRef.current=trade; },[trade]);

  useEffect(()=>{
    loadSaved().then(s=>{
      if(s){setHistory(s.history||[]);setCapital(s.capital||STARTING_CAP);setDayPnL(s.dayPnL||0);setDayLog(s.dayLog||[]);setStreak(s.streak||0);}
      setReady(true);
    });
  },[]);

  useEffect(()=>{
    if(!ready)return;
    setSaving(true);
    const t=setTimeout(()=>savePersist({history,capital,dayPnL,dayLog,streak}).then(()=>setSaving(false)),800);
    return()=>clearTimeout(t);
  },[history,capital,dayPnL,dayLog,streak,ready]);

  const notify=useCallback((msg,type="info")=>{setToast({msg,type});setTimeout(()=>setToast(null),5000);},[]);

  useEffect(()=>{
    if(!("Notification" in window))return;
    setNotifStatus(Notification.permission);
    if(Notification.permission==="default"){Notification.requestPermission().then(p=>setNotifStatus(p));}
  },[]);

  const pushNotify=useCallback((title,body)=>{
    if("Notification" in window&&Notification.permission==="granted"){
      try{new Notification(title,{body,vibrate:[200,100,200]});}catch(e){}
    }
  },[]);

  const requestNotifPermission=useCallback(()=>{
    if("Notification" in window){
      Notification.requestPermission().then(p=>{
        setNotifStatus(p);
        if(p==="granted")notify("Notifications enabled! You will be alerted when signals fire.","success");
      });
    }
  },[notify]);

  const fetchAndUpdate=useCallback(async()=>{
    if(isFetching.current||paused)return;
    isFetching.current=true;
    try{
      const{tickers:newTickers,klines:newKlines}=await loadAllData(klinesCacheRef.current);
      if(Object.keys(newTickers).length>0){
        setApiStatus("live");
        setLastUpdate(new Date());
        setTickers(newTickers);
        klinesCacheRef.current=newKlines;
        setKlinesCache({...newKlines});

        // ── PRICE UPDATE FIX ──
        // Read current trade from ref (not stale closure)
        const currentTrade=tradeRef.current;
        if(currentTrade&&currentTrade.status==="OPEN"){
          const cur=newTickers[currentTrade.pair]?.price;
          if(cur){
            const pl=(cur-currentTrade.entry)/currentTrade.entry*(currentTrade.dir==="BUY"?1:-1);
            const hitTarget=currentTrade.dir==="BUY"?cur>=currentTrade.target:cur<=currentTrade.target;
            if(hitTarget){
              setTrade({...currentTrade,status:"TP",cur,pl});
              pushNotify(`🎯 TARGET HIT — ${currentTrade.pair}`,`${pct(pl*100)} · ${usd(currentTrade.size*pl)} · Tap to close`);
            } else if(pl<=-HARD_STOP){
              setTrade({...currentTrade,status:"SL",cur,pl});
              pushNotify(`🛑 STOP LOSS — ${currentTrade.pair}`,`${pct(pl*100)} · ${usd(currentTrade.size*pl)} · Tap to close`);
            } else {
              setTrade({...currentTrade,cur,pl});
            }
          }
        }

        // Scan for signals
        const found=[];
        for(const pair of PAIRS){
          const sig=analyzeSignal(pair,newKlines[pair],newTickers[pair]);
          if(sig)found.push({...sig,id:`${pair}-${Date.now()}`});
        }
        if(found.length){
          setSignals(prev=>{
            const ex=new Set(prev.map(s=>s.pair));
            const fresh=found.filter(s=>!ex.has(s.pair));
            if(fresh.length){
              notify(`${fresh.length} LIVE signal${fresh.length>1?"s":""} — real Binance data`,"signal");
              fresh.forEach(s=>{
                pushNotify(`🎯 RAVEN TRADE — ${s.pair}`,`${s.dir} · Q${s.quality}/10 · ${Math.abs(s.distFromMean).toFixed(2)}% from mean · Tap to trade`);
              });
            }
            return[...fresh,...prev].slice(0,6);
          });
        }
      }else{setApiStatus("error");}
    }catch(e){setApiStatus("error");}
    finally{isFetching.current=false;}
  },[paused,notify,pushNotify]);

  useEffect(()=>{
    if(!ready)return;
    fetchAndUpdate();
    const id=setInterval(fetchAndUpdate,POLL_MS);
    return()=>clearInterval(id);
  },[ready,fetchAndUpdate]);

  const dailyTarget=capital*DAILY_TARGET;
  const targetHit=dayPnL>=dailyTarget;
  const lossHit=dayPnL<=-(capital*DAILY_LOSS_MAX);
  const streakStop=streak>=CONSEC_LOSS_MAX;
  const capHit=dayLog.length>=MAX_TRADES_DAY;
  const locked=targetHit||lossHit||streakStop||capHit;
  const progress=Math.min(100,Math.max(0,dayPnL/dailyTarget*100));
  const totalPnL=capital-STARTING_CAP;
  const wins=history.filter(t=>t.won).length;
  const losses=history.filter(t=>!t.won).length;
  const wr=history.length?Math.round(wins/history.length*100):0;
  const avgGain=history.length>3?history.reduce((a,t)=>a+t.gain,0)/history.length:null;
  const isOpen=trade&&trade.status==="OPEN";
  const needsExit=trade&&(trade.status==="TP"||trade.status==="SL");
  const statusColor=apiStatus==="live"?CLR.green:apiStatus==="error"?CLR.red:CLR.yel;
  const statusText=apiStatus==="live"?"● LIVE BINANCE":apiStatus==="error"?"● RETRYING…":"● CONNECTING…";

  function enter(sig){
    if(locked){notify("Trading locked for today.","error");return;}
    if(isOpen){notify("Close current trade first.","error");return;}
    const size=capital*RISK_PER_TRADE/HARD_STOP;
    const newTrade={id:sig.id,pair:sig.pair,entry:sig.price,cur:sig.price,size,dir:sig.dir,target:sig.targetPrice,sl:sig.dir==="BUY"?sig.price*(1-HARD_STOP):sig.price*(1+HARD_STOP),why:sig.why,quality:sig.quality,potentialGain:sig.potentialGain,pl:0,status:"OPEN",opened:new Date().toISOString()};
    setTrade(newTrade);
    tradeRef.current=newTrade;
    setSignals(s=>s.filter(x=>x.id!==sig.id));
    notify(`Entered ${sig.pair} @ ${usd(sig.price)}`,"success");
  }

  function closePos(t,approve){
    if(!approve){setTrade(x=>x?{...x,status:"OPEN"}:x);notify(`Holding ${t.pair}.`,"info");return;}
    const gain=t.size*t.pl;const won=t.pl>=0;
    const closed={...t,closed:new Date().toISOString(),gain,won};
    setCapital(c=>c+gain);setDayPnL(d=>d+gain);
    setDayLog(d=>[...d,closed]);setHistory(h=>[closed,...h]);
    setTrade(null);tradeRef.current=null;
    if(won){setStreak(0);}
    else{setStreak(s=>{const n=s+1;if(n>=CONSEC_LOSS_MAX)notify("2 losses in a row — done for today.","error");return n;});}
    notify(`${t.pair} ${won?"WIN":"LOSS"} ${usd(Math.abs(gain))}`,won?"success":"error");
  }

  function deny(id){setSignals(s=>s.filter(x=>x.id!==id));}
  function newDay(){setDayPnL(0);setDayLog([]);setStreak(0);setSignals([]);notify("New day.","info");}
  function resetAll(){if(!window.confirm("Reset to $1,000?"))return;setCapital(STARTING_CAP);setDayPnL(0);setDayLog([]);setHistory([]);setTrade(null);tradeRef.current=null;setSignals([]);setStreak(0);notify("Reset.","info");}

  if(!ready)return(<div style={{background:CLR.bg,minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:12,fontFamily:"'Courier New',monospace"}}><div style={{color:CLR.green,fontSize:26}}>▲</div><div style={{color:CLR.dim,fontSize:11,letterSpacing:3}}>LOADING…</div></div>);

  return(<div style={{background:CLR.bg,minHeight:"100vh",fontFamily:"'Courier New',monospace",color:"#bbb",paddingBottom:56}}><style>{CSS}</style>
  {toast&&(<div className="toast" style={{borderColor:toast.type==="success"?CLR.green:toast.type==="error"?CLR.red:toast.type==="signal"?"#9b6dff":"#444",background:toast.type==="success"?"#00ff9d12":toast.type==="error"?"#ff4d4d12":"#7b5ea715"}}>{toast.msg}</div>)}

  <div style={{background:CLR.dark,borderBottom:`1px solid ${CLR.bdr}`,padding:"11px 14px",display:"flex",flexWrap:"wrap",gap:10,alignItems:"center",justifyContent:"space-between"}}>
    <div style={{display:"flex",alignItems:"center",gap:10}}><span style={{color:CLR.green,fontSize:20}}>▲</span><div><div style={{color:"#fff",fontWeight:700,fontSize:14,letterSpacing:3}}>RAVEN TRADE</div><div style={{fontSize:9,letterSpacing:2,display:"flex",gap:6,alignItems:"center"}}><span style={{color:statusColor}}>{statusText}</span>{lastUpdate&&<span style={{color:"#222"}}>{lastUpdate.toLocaleTimeString()}</span>}</div></div></div>
    <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>{[["Capital",usd(capital),capital>=STARTING_CAP?CLR.green:CLR.red],["P&L",usd(totalPnL),totalPnL>=0?CLR.green:CLR.red],["Today",usd(dayPnL),dayPnL>=0?CLR.green:CLR.red],["Win%",wr+"%",wr>=60?CLR.green:wr>=45?CLR.yel:CLR.red]].map(([l,v,c])=>(<div key={l} style={{textAlign:"center"}}><div style={{color:"#2a2a2a",fontSize:9,letterSpacing:1}}>{l}</div><div style={{color:c,fontWeight:700,fontSize:12,fontFamily:"monospace"}}>{v}</div></div>))}</div>
    <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
      <TinyBtn onClick={()=>setPaused(p=>!p)} col={paused?CLR.green:CLR.red}>{paused?"▶":"⏸"}</TinyBtn>
      <TinyBtn onClick={newDay} col="#444">New Day</TinyBtn>
      <TinyBtn onClick={resetAll} col="#ff4d4d44">Reset</TinyBtn>
      {notifStatus!=="granted"&&<TinyBtn onClick={requestNotifPermission} col={CLR.yel}>🔔 Enable Alerts</TinyBtn>}
      {notifStatus==="granted"&&<span style={{color:CLR.green,fontSize:9,padding:"5px 8px",border:`1px solid ${CLR.green}44`,borderRadius:4}}>🔔 ON</span>}
    </div>
  </div>

  <div style={{background:CLR.dark,borderBottom:`1px solid ${CLR.bdr}`,padding:"10px 14px"}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
      <div style={{display:"flex",gap:8,alignItems:"center"}}><span style={{color:targetHit?CLR.green:CLR.yel,fontWeight:700,fontSize:11,letterSpacing:1}}>{targetHit?"✅ TARGET HIT":"🎯 DAILY MISSION"}</span><span style={{color:CLR.dim,fontSize:10}}>{usd(Math.max(0,dayPnL))} / {usd(dailyTarget)}</span></div>
      <div style={{display:"flex",gap:8,alignItems:"center"}}>
        <div style={{display:"flex",gap:3}}>{[0,1,2].map(i=>(<div key={i} style={{width:10,height:10,borderRadius:"50%",background:dayLog.length>i?CLR.green:CLR.bdr,border:`1px solid ${dayLog.length>i?CLR.green:"#252525"}`,transition:"all 0.3s"}}/>))}<span style={{color:"#222",fontSize:9,marginLeft:3}}>{dayLog.length}/{MAX_TRADES_DAY}</span></div>
        {streak>0&&<span style={{color:CLR.red,fontSize:9,border:`1px solid ${CLR.red}44`,padding:"1px 6px",borderRadius:3}}>{streak} loss{streak>1?"es":""}</span>}
      </div>
    </div>
    <div style={{background:"#0d1117",borderRadius:4,height:6,overflow:"hidden"}}><div style={{width:progress+"%",height:"100%",background:targetHit?CLR.green:dayPnL<0?CLR.red:CLR.yel,borderRadius:4,transition:"width 0.8s"}}/></div>
    <div style={{marginTop:5,fontSize:10,color:CLR.dim}}>{targetHit?"Done. Protect your capital.":lossHit?"Daily loss limit hit.":streakStop?"Two losses — walk away.":capHit?"3 trades taken. Done.":`${usd(Math.max(0,dailyTarget-dayPnL))} to target`}</div>
  </div>

  {needsExit&&(<div style={{margin:"8px 14px 0",background:CLR.dark,border:`1px solid ${trade.status==="TP"?CLR.green:CLR.red}55`,borderRadius:10,padding:"12px 14px"}}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}><div><div style={{color:trade.status==="TP"?CLR.green:CLR.red,fontWeight:700,fontSize:11,letterSpacing:1,marginBottom:4}}>{trade.status==="TP"?"🎯 TARGET HIT":"🛑 HARD STOP HIT"}</div><div style={{color:"#fff",fontWeight:700,fontSize:18}}>{trade.pair}</div><div style={{display:"flex",gap:12,marginTop:6}}><span style={{color:trade.pl>=0?CLR.green:CLR.red,fontWeight:700,fontSize:15}}>{pct(trade.pl*100)}</span><span style={{color:trade.pl>=0?CLR.green:CLR.red,fontWeight:700,fontSize:15}}>{usd(trade.size*trade.pl)}</span></div></div><div style={{display:"flex",flexDirection:"column",gap:6}}><button className="abtn" style={{padding:"10px 20px"}} onClick={()=>closePos(trade,true)}>✅ CLOSE</button><button style={{padding:"8px 20px",background:"transparent",border:"1px solid #ffffff11",color:"#555",borderRadius:6,cursor:"pointer",fontFamily:"inherit",fontSize:11}} onClick={()=>closePos(trade,false)}>⏳ HOLD</button></div></div></div>)}

  <div style={{display:"flex",borderBottom:`1px solid ${CLR.bdr}`,paddingLeft:14}}>{[["trade","📡 TRADE"],["position",`💼 POSITION${isOpen?" (1)":""}`],["log",`📒 LOG (${history.length})`],["growth","📈 GROWTH"]].map(([id,lbl])=>(<button key={id} onClick={()=>setTab(id)} style={{padding:"8px 12px",background:"transparent",border:"none",borderBottom:`2px solid ${tab===id?CLR.green:"transparent"}`,color:tab===id?CLR.green:CLR.dim,cursor:"pointer",fontFamily:"inherit",fontSize:10,letterSpacing:1}}>{lbl}</button>))}</div>

  <div style={{padding:"12px 14px",display:"flex",flexDirection:"column",gap:10}}>
  {tab==="trade"&&<>
    <div style={{background:CLR.dark,border:`1px solid ${CLR.bdr}`,borderRadius:8,padding:"10px 14px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
      <div><div style={{color:CLR.yel,fontSize:10,fontWeight:700,letterSpacing:2}}>LIVE MARKET DATA</div><div style={{color:"#444",fontSize:10,marginTop:2}}>Real Binance · Updates every 15s · BB+RSI+MACD</div></div>
      <div style={{color:statusColor,fontSize:11,fontWeight:700}}>{apiStatus==="live"?"LIVE":apiStatus==="error"?"RETRYING":"CONNECTING"}</div>
    </div>
    {notifStatus!=="granted"&&(<div style={{background:"#ffd16614",border:`1px solid ${CLR.yel}44`,borderRadius:8,padding:"10px 14px",display:"flex",justifyContent:"space-between",alignItems:"center"}}><div><div style={{color:CLR.yel,fontSize:11,fontWeight:700}}>🔔 Enable Signal Notifications</div><div style={{color:"#555",fontSize:10,marginTop:2}}>Get alerted on your phone the moment a signal fires</div></div><button onClick={requestNotifPermission} style={{padding:"6px 14px",background:CLR.yel+"22",border:`1px solid ${CLR.yel}`,color:CLR.yel,borderRadius:6,cursor:"pointer",fontFamily:"inherit",fontSize:10,fontWeight:700}}>ENABLE</button></div>)}
    {locked&&!isOpen&&(<div style={{background:CLR.dark,border:`1px solid ${targetHit?CLR.green:CLR.red}44`,borderRadius:10,padding:"20px 14px",textAlign:"center"}}><div style={{fontSize:26,marginBottom:8}}>{targetHit?"✅":streakStop?"⛔":"🏁"}</div><div style={{color:targetHit?CLR.green:CLR.red,fontWeight:700,fontSize:12,letterSpacing:2,marginBottom:8}}>{targetHit?"DAILY TARGET HIT":streakStop?"LOSS LOCKOUT":capHit?"3 TRADES TAKEN":"LOSS LIMIT"}</div><div style={{color:"#555",fontSize:11}}>{targetHit?`${usd(dayPnL)} made today. Log off.`:streakStop?"Rest. Back tomorrow.":capHit?"Discipline is the edge.":"Capital protected."}</div></div>)}
    {isOpen&&(<div style={{background:CLR.dark,border:`1px solid ${trade.pl>=0?CLR.green:CLR.red}33`,borderRadius:10,padding:"12px 14px"}}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}><span style={{color:"#fff",fontWeight:700,fontSize:15}}>{trade.pair} <span style={{color:CLR.dim,fontSize:10}}>{trade.dir}</span></span><span style={{color:trade.pl>=0?CLR.green:CLR.red,fontWeight:700,fontSize:15}}>{pct(trade.pl*100)}</span></div><div style={{display:"flex",gap:14,marginTop:8,flexWrap:"wrap"}}>{[["Entry",usd(trade.entry),"#555"],["Now",usd(trade.cur),"#fff"],["P&L",usd(trade.size*trade.pl),trade.pl>=0?CLR.green:CLR.red],["Target",usd(trade.target),CLR.green],["Stop",usd(trade.sl),CLR.red]].map(([l,v,c])=>(<div key={l}><div style={{color:"#2a2a2a",fontSize:9}}>{l}</div><div style={{color:c,fontWeight:700,fontSize:12}}>{v}</div></div>))}</div><div style={{marginTop:8,background:"#0d1117",borderRadius:3,height:3,overflow:"hidden"}}><div style={{width:Math.min(100,Math.max(0,trade.pl/(Math.abs(trade.target-trade.entry)/trade.entry)*100))+"%",height:"100%",background:CLR.green,borderRadius:3,transition:"width 0.5s"}}/></div><button style={{marginTop:8,width:"100%",padding:"8px",background:"transparent",border:"1px solid #ffffff09",color:"#333",borderRadius:6,cursor:"pointer",fontFamily:"inherit",fontSize:10}} onClick={()=>closePos({...trade},true)}>Exit Manually</button></div>)}
    {!locked&&!isOpen&&signals.length===0&&(<div style={{textAlign:"center",padding:"50px 20px"}}><div className="pulse" style={{fontSize:34}}>📡</div><div style={{color:"#1e1e1e",fontSize:12,marginTop:12,letterSpacing:2}}>{apiStatus==="live"?"SCANNING LIVE BINANCE MARKET…":"CONNECTING TO BINANCE…"}</div><div style={{color:"#161616",fontSize:10,marginTop:6}}>Real prices · Updates every 15 seconds</div></div>)}
    {!locked&&!isOpen&&signals.map(sig=>(<SigCard key={sig.id} sig={sig} capitalNow={capital} onEnter={()=>enter(sig)} onDeny={()=>deny(sig.id)}/>))}
  </>}
  {tab==="position"&&<>{!isOpen&&<div style={{textAlign:"center",padding:"50px 20px"}}><div style={{fontSize:30}}>💼</div><div style={{color:CLR.dim,fontSize:12,marginTop:10}}>No open position</div></div>}{isOpen&&<PosCard trade={trade} onClose={()=>closePos({...trade},true)}/>}</>}
  {tab==="log"&&<>
    <div style={{background:CLR.dark,borderRadius:10,padding:"12px 14px",display:"flex",flexWrap:"wrap"}}>{[["Trades",history.length,"#888"],["Wins",wins,CLR.green],["Losses",losses,CLR.red],["Win%",wr+"%",wr>=60?CLR.green:wr>=45?CLR.yel:CLR.red],["Net P&L",usd(totalPnL),totalPnL>=0?CLR.green:CLR.red]].map(([l,v,c])=>(<div key={l} style={{flex:1,textAlign:"center",minWidth:50}}><div style={{color:CLR.dim,fontSize:9}}>{l}</div><div style={{color:c,fontWeight:700,fontSize:12}}>{v}</div></div>))}</div>
    {avgGain!==null&&(<div style={{background:CLR.dark,border:`1px solid ${CLR.bdr}`,borderRadius:10,padding:"12px 14px"}}><div style={{color:CLR.dim,fontSize:10,letterSpacing:2,marginBottom:8}}>DAILY PROJECTION ({usd(avgGain)}/trade avg)</div><div style={{display:"flex"}}>{[["1 trade",avgGain],["2 trades",avgGain*2],["3 trades",avgGain*3]].map(([l,v])=>(<div key={l} style={{flex:1,textAlign:"center",borderRight:`1px solid ${CLR.bdr}`,padding:"6px 4px"}}><div style={{color:CLR.dim,fontSize:9,marginBottom:3}}>{l}/day</div><div style={{color:v>=0?CLR.green:CLR.red,fontWeight:700,fontSize:14}}>{usd(v)}</div></div>))}</div></div>)}
    {history.length>=10&&(<div style={{background:CLR.dark,border:`1px solid ${wr>=60?CLR.green:wr>=45?CLR.yel:CLR.red}33`,borderRadius:10,padding:"12px 14px"}}><div style={{color:CLR.dim,fontSize:10,letterSpacing:2,marginBottom:8}}>REAL MONEY READINESS</div><div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6}}><div style={{flex:1,background:"#0d1117",borderRadius:4,height:6}}><div style={{width:Math.min(100,wr)+"%",height:"100%",background:wr>=60?CLR.green:wr>=45?CLR.yel:CLR.red,borderRadius:4,transition:"width 1s"}}/></div><span style={{color:wr>=60?CLR.green:wr>=45?CLR.yel:CLR.red,fontWeight:700,fontSize:12}}>{wr}%</span></div><div style={{color:CLR.dim,fontSize:11}}>{wr>=60?"✅ Strong. 30 days → go live with $2,500.":wr>=45?"⚠️ Building. Keep logging.":"❌ Not ready. Stay paper trading."}</div></div>)}
    {history.length===0&&<div style={{textAlign:"center",padding:"40px 20px"}}><div style={{fontSize:30}}>📒</div><div style={{color:CLR.dim,fontSize:12,marginTop:10}}>Trade history builds here</div></div>}
    {history.map((t,i)=>(<div key={i} style={{background:CLR.dark,borderRadius:8,padding:"11px 12px",borderLeft:`3px solid ${t.won?CLR.green:CLR.red}`}}><div style={{display:"flex",justifyContent:"space-between"}}><span style={{color:"#fff",fontWeight:700}}>{t.pair} <span style={{color:CLR.dim,fontSize:9}}>{t.dir}</span></span><span style={{color:t.won?CLR.green:CLR.red,fontWeight:700}}>{t.won?"WIN":"LOSS"} {usd(Math.abs(t.gain))}</span></div><div style={{display:"flex",gap:10,marginTop:4,flexWrap:"wrap"}}><span style={{color:"#333",fontSize:10}}>Entry {usd(t.entry)}</span><span style={{color:"#333",fontSize:10}}>Exit {usd(t.cur)}</span><span style={{color:t.pl>=0?CLR.green:CLR.red,fontSize:10}}>{pct(t.pl*100)}</span><span style={{color:"#1e1e1e",fontSize:10}}>{t.closed?new Date(t.closed).toLocaleTimeString():""}</span></div><div style={{display:"flex",gap:4,marginTop:5,flexWrap:"wrap"}}>{t.why?.map(s=>(<span key={s} style={{background:"#7b5ea712",color:"#7b5ea7",border:"1px solid #7b5ea728",borderRadius:3,padding:"1px 6px",fontSize:9}}>{s}</span>))}</div></div>))}
  </>}
  {tab==="growth"&&<GrowthTab currentCapital={capital}/>}
  </div>

  <div style={{position:"fixed",bottom:0,left:0,right:0,background:"#080b10",borderTop:`1px solid ${CLR.bdr}`,padding:"4px 0",overflow:"hidden"}}><div className="ticker">{[...PAIRS,...PAIRS].map((p,i)=>{const t=tickers[p];const c=t?.change24||0;return(<span key={i} style={{padding:"0 12px",fontSize:10,borderRight:`1px solid ${CLR.bdr}`,whiteSpace:"nowrap"}}><span style={{color:"#333"}}>{p.replace("/USDT","")}</span><span style={{color:"#555",margin:"0 4px"}}>{usd(t?.price)}</span><span style={{color:c>=0?CLR.green:CLR.red,fontSize:9}}>{pct(c)}</span></span>);})}</div></div>
  </div>);}

function SigCard({sig,capitalNow,onEnter,onDeny}){const size=capitalNow*RISK_PER_TRADE/HARD_STOP;const isBuy=sig.dir==="BUY";const qColor=sig.quality>=8?CLR.green:sig.quality>=6?CLR.yel:CLR.red;return(<div className="card" style={{background:CLR.dark,border:`1px solid ${CLR.bdr}`,borderRadius:10,padding:"14px"}}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}><div style={{display:"flex",alignItems:"center",gap:8}}><span style={{background:isBuy?"#00ff9d12":"#ff6b6b12",color:isBuy?CLR.green:CLR.red,border:`1px solid ${isBuy?CLR.green:CLR.red}`,padding:"3px 9px",borderRadius:4,fontSize:10,fontWeight:700}}>{isBuy?"▲ BUY":"▼ SHORT"}</span><span style={{color:"#fff",fontWeight:700,fontSize:17}}>{sig.pair}</span></div><div style={{display:"flex",gap:6,alignItems:"center"}}><span style={{color:CLR.green,fontSize:9,border:"1px solid #00ff9d33",padding:"1px 6px",borderRadius:3}}>LIVE</span><span style={{color:qColor,border:`1px solid ${qColor}33`,padding:"2px 8px",borderRadius:4,fontSize:10}}>Q{sig.quality}/10</span></div></div><div style={{display:"flex",alignItems:"baseline",gap:10,marginBottom:10}}><span style={{color:"#fff",fontSize:22,fontWeight:700}}>{usd(sig.price)}</span><span style={{color:sig.change24>=0?CLR.green:CLR.red,fontSize:11}}>{pct(sig.change24)} 24h</span><span style={{color:isBuy?CLR.red:CLR.green,fontSize:10}}>{Math.abs(sig.distFromMean).toFixed(2)}% from mean</span></div><div style={{background:"#060910",borderRadius:8,padding:"10px",marginBottom:10}}><div style={{color:"#1e1e1e",fontSize:9,letterSpacing:2,marginBottom:6}}>LIVE SIGNAL</div><div style={{display:"flex",flexWrap:"wrap",gap:5,marginBottom:6}}>{sig.why.map(w=>(<span key={w} style={{background:"#7b5ea712",color:"#8b6ee7",border:"1px solid #7b5ea728",borderRadius:3,padding:"2px 7px",fontSize:10}}>{w}</span>))}</div><div style={{display:"flex",gap:10,flexWrap:"wrap"}}><span style={{color:CLR.dim,fontSize:10}}>SMA <span style={{color:"#777"}}>{usd(sig.sma)}</span></span><span style={{color:CLR.dim,fontSize:10}}>RSI <span style={{color:sig.rsi<35?CLR.green:sig.rsi>65?CLR.red:CLR.yel}}>{sig.rsi.toFixed(0)}</span></span><span style={{color:CLR.dim,fontSize:10}}>Hi <span style={{color:"#555"}}>{usd(sig.high24)}</span></span><span style={{color:CLR.dim,fontSize:10}}>Lo <span style={{color:"#555"}}>{usd(sig.low24)}</span></span></div><div style={{color:"#555",fontSize:11,marginTop:6}}>Target: <span style={{color:"#888",fontWeight:700}}>{usd(sig.targetPrice)}</span> <span style={{color:CLR.green}}>(+{f2(sig.potentialGain)}%)</span></div></div><div style={{display:"flex",gap:8,marginBottom:12}}>{[["POSITION",usd(size),"#888"],["MAX RISK",usd(size*HARD_STOP),CLR.red],["TARGET",usd(sig.targetPrice),CLR.green]].map(([l,v,c])=>(<div key={l} style={{flex:1,background:"#060910",border:`1px solid ${CLR.bdr}`,borderRadius:6,padding:"7px 4px",textAlign:"center"}}><div style={{color:"#1e1e1e",fontSize:8,marginBottom:2}}>{l}</div><div style={{color:c,fontSize:11,fontWeight:700}}>{v}</div></div>))}</div><div style={{display:"flex",gap:8}}><button className="abtn" onClick={onEnter}>✅ ENTER TRADE</button><button style={{padding:"11px 14px",background:"transparent",border:"1px solid #ff4d4d18",color:"#ff6b6b33",borderRadius:6,cursor:"pointer",fontFamily:"inherit",fontSize:11}} onClick={onDeny}>✗ PASS</button></div></div>);}

function PosCard({trade,onClose}){const gain=trade.size*trade.pl;const isG=trade.pl>=0;const targetDist=Math.abs(trade.target-trade.entry);const prog=targetDist>0?Math.min(100,Math.max(0,Math.abs(trade.cur-trade.entry)/targetDist*100)):0;return(<div style={{background:CLR.dark,border:`1px solid ${isG?CLR.green:CLR.red}22`,borderRadius:10,padding:"14px"}}><div style={{display:"flex",justifyContent:"space-between"}}><span style={{color:"#fff",fontWeight:700,fontSize:17}}>{trade.pair} <span style={{color:CLR.dim,fontSize:10}}>{trade.dir}</span></span><span style={{color:isG?CLR.green:CLR.red,fontWeight:700,fontSize:17}}>{pct(trade.pl*100)}</span></div><div style={{display:"flex",gap:14,marginTop:10,flexWrap:"wrap"}}>{[["ENTRY",usd(trade.entry),"#555"],["NOW",usd(trade.cur),"#fff"],["P&L",usd(gain),isG?CLR.green:CLR.red],["TARGET",usd(trade.target),CLR.green],["STOP",usd(trade.sl),CLR.red]].map(([l,v,c])=>(<div key={l}><div style={{color:"#2a2a2a",fontSize:9}}>{l}</div><div style={{color:c,fontWeight:700,fontSize:12}}>{v}</div></div>))}</div><div style={{marginTop:10,background:"#0d1117",borderRadius:3,height:5,overflow:"hidden"}}><div style={{width:prog+"%",height:"100%",background:CLR.green,transition:"width 0.5s",borderRadius:3}}/></div><div style={{color:"#2a2a2a",fontSize:9,marginTop:3}}>{Math.round(prog)}% toward target</div><button style={{marginTop:10,width:"100%",padding:"9px",background:"transparent",border:"1px solid #ffffff09",color:"#333",borderRadius:6,cursor:"pointer",fontFamily:"inherit",fontSize:11}} onClick={onClose}>Exit Manually</button></div>);}

function GrowthTab({currentCapital}){const milestones=[1000,2500,5000,10000,25000,50000,100000];const rows=[];let b=currentCapital;for(let d=1;d<=120;d++){b=b*(1+DAILY_TARGET);rows.push({d,b});}return(<div style={{display:"flex",flexDirection:"column",gap:10}}><div style={{background:CLR.dark,border:`1px solid ${CLR.bdr}`,borderRadius:10,padding:"14px"}}><div style={{color:CLR.yel,fontSize:10,fontWeight:700,letterSpacing:2,marginBottom:12}}>COMPOUND WEALTH ROADMAP</div>{milestones.map(m=>{const days=rows.find(r=>r.b>=m)?.d??null;const hit=currentCapital>=m;return(<div key={m} style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}><div style={{width:9,height:9,borderRadius:"50%",background:hit?CLR.green:CLR.bdr,border:`1px solid ${hit?CLR.green:"#252525"}`,flexShrink:0}}/><div style={{flex:1,display:"flex",justifyContent:"space-between"}}><span style={{color:hit?"#ddd":"#333",fontWeight:hit?700:400,fontSize:13}}>{usd(m)}</span><span style={{color:hit?CLR.green:CLR.dim,fontSize:11}}>{hit?"✅ REACHED":days?`~${days} trading days`:"—"}</span></div></div>);})}</div><div style={{background:CLR.dark,border:`1px solid ${CLR.bdr}`,borderRadius:10,padding:"14px"}}><div style={{color:CLR.dim,fontSize:10,letterSpacing:2,marginBottom:10}}>DAILY INCOME AT EACH LEVEL</div>{[[1000,80],[2500,200],[5000,400],[10000,800],[100000,8000]].map(([cap,t])=>(<div key={cap} style={{display:"flex",justifyContent:"space-between",marginBottom:8,paddingBottom:8,borderBottom:`1px solid ${CLR.bdr}`}}><span style={{color:currentCapital>=cap?"#777":"#222",fontSize:12}}>{usd(cap)}</span><span style={{color:currentCapital>=cap?CLR.green:"#222",fontWeight:700,fontSize:13}}>{usd(t)}/day</span></div>))}</div></div>);}

function TinyBtn({children,onClick,col}){return(<button onClick={onClick} style={{padding:"5px 10px",background:"transparent",border:`1px solid ${col}`,borderRadius:4,color:col,cursor:"pointer",fontFamily:"inherit",fontSize:10,letterSpacing:1}}>{children}</button>);}

const CSS=`*{box-sizing:border-box;}body{margin:0;background:#060910;}@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.15}}.pulse{animation:pulse 3s ease-in-out infinite;}@keyframes ticker{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}.ticker{display:flex;width:max-content;animation:ticker 50s linear infinite;}.ticker:hover{animation-play-state:paused;}.card:hover{border-color:#1e2840!important;}.abtn{flex:1;padding:11px;background:#00ff9d15;border:1px solid #00ff9d;color:#00ff9d;border-radius:6px;cursor:pointer;font-family:inherit;font-weight:700;font-size:11px;letter-spacing:2px;}.abtn:hover{background:#00ff9d28!important;}.toast{position:fixed;top:14px;right:14px;z-index:9999;padding:10px 16px;border-radius:8px;border:1px solid;font-family:'Courier New',monospace;font-size:11px;backdrop-filter:blur(12px);}::-webkit-scrollbar{width:2px;}::-webkit-scrollbar-thumb{background:#161e2e;border-radius:2px;}`;
