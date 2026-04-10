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
const TICK_MS=3000;
const BASE_PRICES={"BTC/USDT":67200,"ETH/USDT":3480,"SOL/USDT":168,"BNB/USDT":598,"XRP/USDT":0.52,"DOGE/USDT":0.162,"ADA/USDT":0.44,"AVAX/USDT":37,"LINK/USDT":14.8,"LTC/USDT":82};
const CLR={green:"#00ff9d",red:"#ff6b6b",yel:"#ffd166",dim:"#3a3a3a",dark:"#0d1117",bg:"#060910",bdr:"#161e2e"};
async function loadSaved(){try{const r=await window.storage.get(STORAGE_KEY);return r?JSON.parse(r.value):null;}catch{return null;}}
async function savePersist(d){try{await window.storage.set(STORAGE_KEY,JSON.stringify(d));}catch{}}
function calcSMA(arr,n){const s=arr.slice(-n);return s.reduce((a,b)=>a+b,0)/s.length;}
function calcStd(arr,mean){return Math.sqrt(arr.reduce((s,v)=>s+Math.pow(v-mean,2),0)/arr.length);}
function calcRSI(prices,period=14){if(prices.length<period+1)return 50;let gains=0,losses=0;for(let i=prices.length-period;i<prices.length;i++){const d=prices[i]-prices[i-1];if(d>0)gains+=d;else losses-=d;}const g=gains/period,l=losses/period;return l===0?100:100-(100/(1+g/l));}
function calcMACD(prices){if(prices.length<26)return{macd:0,signal:0};const ema=(p,n)=>{const k=2/(n+1);return p.slice(-n).reduce((e,v)=>v*k+e*(1-k));};const macd=ema(prices,12)-ema(prices,26);return{macd,signal:macd*0.8};}
function buildHistory(base,bars=50){const h=[base];let trend=(Math.random()-0.5)*0.001;for(let i=1;i<bars;i++){const dist=(h[h.length-1]-base)/base;const rev=-dist*0.12;const drift=trend*(1-Math.abs(dist)*5);const noise=(Math.random()-0.5)*0.008;trend=trend*0.97+(Math.random()-0.5)*0.0005;h.push(Math.max(base*0.7,h[h.length-1]*(1+rev+drift+noise)));}return h;}
function buildPairState(base){const b=base*(0.98+Math.random()*0.04);const hist=buildHistory(b);const sma=calcSMA(hist,BB_PERIOD);
