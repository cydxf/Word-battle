/* ==============================================================
 * Word Battle – V2.0   ►  『极速 PK』+ 原学习 / 复习模块
 *   - 学习/复习逻辑与 V1.3.1 完全保留
 *   - 全新 PK 流程（单轮、倒计时、实时比分）
 * ============================================================== */

import seedrandom from 'https://cdn.jsdelivr.net/npm/seedrandom@3.0.5/+esm'; // 为了双方题序一致


const $ = s => document.querySelector(s);
const app = $('#app');

// 在 app.js 顶部（DOM 完成后）挂事件
$('#fullscreen').onclick = () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen?.();
  } else {
    document.exitFullscreen?.();
  }
};


/* ---------- IndexedDB ---------- */
const DB     = { name: 'word-battle-db', version: 3 };
const STORE  = { BOX: 'box', PTR: 'ptr', SES: 'session' };
function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB.name, DB.version);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE.BOX)) db.createObjectStore(STORE.BOX);
      if (!db.objectStoreNames.contains(STORE.PTR)) db.createObjectStore(STORE.PTR);
      if (!db.objectStoreNames.contains(STORE.SES)) db.createObjectStore(STORE.SES);
    };
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}
const idb = openDB();
const idbGet = async (st,k,d=null)=>new Promise(async r=>{
  (await idb).transaction(st).objectStore(st).get(k).onsuccess=e=>r(e.target.result??d);
});
const idbSet = async (st,k,v)=>new Promise(async r=>{
  const t=(await idb).transaction(st,'readwrite');t.objectStore(st).put(v,k);
  t.oncomplete=r;
});
const idbDel = async (st,k)=>{(await idb).transaction(st,'readwrite').objectStore(st).delete(k);};

/* ---------- 状态 ---------- */
let WORD_FILES = [];
let CFG = { bank:'', batch:10, mode:'learn', roomId:'' };
let wordbank = [];
let rounds   = [];
let idx      = 0;
let missed   = [];
let scoreCorrect = 0;
let socket   = null;

/* ---------- 初始化 ---------- */
(async()=>{
  WORD_FILES = await fetch('/api/wordbanks').then(r=>r.json());
  renderHome();
})();

/* ---------- UI ---------- */
function renderHome() {
  // 确保 `#view` 元素始终存在
  if (!$('#view')) {
    document.body.innerHTML = `
      <main id="app">
        <div class="topbar">
          <h1>Word Battle 👑</h1>
          <button id="fullscreen" class="full-btn" title="全屏 / 退出全屏">⛶</button>
        </div>
        <section class="main" id="view"></section>
      </main>
    `;
  }

  // 仅更新 #view 部分，确保不丢失状态
  $('#view').innerHTML = `
    <h1>Word Battle 👑</h1>
    <div class="form-row">
      <label>词库：
        <select id="bank">${WORD_FILES.map(f => `<option>${f}</option>`).join('')}</select>
      </label><br><br>
      <label>每批<strong>学习</strong>量：
        <input id="batch" type="number" min="1" max="200" value="10">
      </label><br><br>
    </div>
    <div class="center">
      <button id="learn" class="primary">开始 / 继续学习</button>
      <button id="review" class="secondary">开始 / 继续复习</button>
      <button id="pk" class="warn">好友对战</button>
    </div>
  `;

  // 重新绑定按钮事件
  $('#learn').onclick = () => startFlow('learn');
  $('#review').onclick = () => startFlow('review');
  $('#pk').onclick = pkFlow;
}


function renderWaiting(){
  $('#view').innerHTML=`
    <div class="waiting">
      <p>匹配中，请稍候…</p>
      <button id="cancel" class="secondary">取消匹配</button>
    </div>`;
  $('#cancel').onclick=()=>{
    socket.emit('leave-room',CFG.roomId);
    renderHome();
  };
}

/* ---------- 工具 ---------- */
const shuffle=a=>[...a].sort(()=>Math.random()-.5);
const randomPick=(field,ans,n=3)=>shuffle(wordbank.filter(w=>w[field]!==ans)).slice(0,n).map(w=>w[field]);
function playBeep(freq){
  try{
    const ctx=new (window.AudioContext||window.webkitAudioContext)();
    const o=ctx.createOscillator(),g=ctx.createGain();
    o.frequency.value=freq;o.type='sine';o.connect(g);g.connect(ctx.destination);
    o.start();o.stop(ctx.currentTime+.18);
  }catch{}
}

/* ---------- 题面包装 ---------- */
function wrapRounds(){
  rounds = rounds.map(w=>{
    const pool=navigator.onLine?[0,1,2]:[0,1];             // 2 = 音频→中文
    const t=pool[Math.floor(Math.random()*pool.length)];
    let q,a,qType='text';
    if(t===0){q=w.en; a=w.zh;}
    else if(t===1){q=w.zh; a=w.en;}
    else {q='🔊'; a=w.zh; qType='audio';}
    return {
      word:w,question:q,answer:a,qType,
      choices:shuffle([a,...randomPick(t===1?'en':'zh',a,3)])
    };
  });
}

/* ---------- 学习 / 复习 批量 ---------- */
async function loadWordbank(name){
  wordbank = await fetch(`/api/wordbank/${name}`).then(r=>r.json());
}
async function buildLearnBatch(){
  const ptrKey=`${CFG.bank}-ptr`;
  let cur = await idbGet(STORE.PTR,ptrKey,0);
  const tot = wordbank.length;
  rounds=[];
  for(let i=0;rounds.length<CFG.batch && i<tot;i++){
    const w=wordbank[(cur+i)%tot];
    const lvl=await idbGet(STORE.BOX,w.en,0);
    if(lvl===0) rounds.push(w);
  }
  if(!rounds.length){alert('已学完全部新词 👍');return false;}
  await idbSet(STORE.PTR,ptrKey,(cur+CFG.batch)%tot);
  return true;
}
async function buildReviewBatch(){
  const learned=[];
  await new Promise(async r=>{
    const req=(await idb).transaction(STORE.BOX).objectStore(STORE.BOX).openCursor();
    req.onsuccess=e=>{
      const c=e.target.result;if(c){if(c.value>0)learned.push(c.key);c.continue();}
      else r();
    };
  });
  if(!learned.length){alert('暂无已学单词可复习');return false;}
  rounds = shuffle(learned).slice(0,CFG.batch*2).map(en=>wordbank.find(w=>w.en===en));
  return true;
}

/* ---------- 会话键 ---------- */
const sessionKey=()=>`${CFG.mode}-${CFG.bank}-${CFG.batch}`;

/* ---------- 渲染 Quiz ---------- */
async function renderQuiz(){
  if(idx>=rounds.length){
    if(missed.length){
      rounds=missed;missed=[];wrapRounds();idx=0;
      await saveSession();return renderQuiz();
    }
    await idbDel(STORE.SES,sessionKey());
    return CFG.mode==='pk'?submitPK():renderFinish();
  }
  const r=rounds[idx];
$('#view').innerHTML = `
    <p>${idx+1}/${rounds.length}</p>
    <div class="question">${r.qType==='audio'?`<button id="play">▶️</button>`:r.question}</div>
    <div class="options">${r.choices.map(c=>`<button>${c}</button>`).join('')}</div>
    <div class="center"><button id="exit" class="secondary">退出并保存</button></div>`;
  if(r.qType==='audio'){
    const a=new Audio(r.word.audio);a.play();
    $('#play').onclick=()=>new Audio(r.word.audio).play();
  }
  app.querySelectorAll('.options button').forEach(b=>b.onclick=()=>judge(b,r));
  $('#exit').onclick=async()=>{await saveSession();renderHome();};
}

async function judge(btn,r){
  const ok = btn.textContent===r.answer;
  btn.classList.add(ok?'correct':'wrong');
  playBeep(ok?700:300);
  const lv=await idbGet(STORE.BOX,r.word.en,0);
  await idbSet(STORE.BOX,r.word.en,Math.max(0,lv+(ok?1:-1)));
  if(!ok) missed.push(r.word); else scoreCorrect++;
  idx++;await saveSession();setTimeout(renderQuiz,450);
}

/* ---------- 保存 / 恢复 ---------- */
async function saveSession(){
  await idbSet(STORE.SES,sessionKey(),{idx,rounds,missed,scoreCorrect});
}
async function loadSession(){
  return await idbGet(STORE.SES,sessionKey(),null);
}

/* ---------- 主流程 ---------- */
async function startFlow(mode,restart=false){
  // 仅当首页元素存在时才重置 CFG
  if(!restart){
    if($('#bank'))  CFG.bank  = $('#bank').value;
    if($('#batch')) CFG.batch = parseInt($('#batch').value,10);
  }
  CFG.mode=mode;

  await loadWordbank(CFG.bank);                // 先保证词库已就绪

  const saved = await loadSession();
  if(saved && !restart){
    ({idx,rounds,missed,scoreCorrect}=saved);
    // 若旧 session 缺 choices → 升级
    if(!rounds[0]?.choices) wrapRounds();
    return renderQuiz();
  }

  // 新批次
  const ok = mode==='learn' ? await buildLearnBatch() : await buildReviewBatch();
  if(!ok) return renderHome();
  wrapRounds(); idx=0; missed=[]; scoreCorrect=0;
  await saveSession(); renderQuiz();
}

/* ---------- Finish ---------- */
function renderFinish(){
  $('#view').innerHTML=`
    <h2 class="center">🎉 本批完成！正确 ${scoreCorrect}/${CFG.mode==='review'?CFG.batch*2:CFG.batch}</h2>
    <div class="center">
      <button id="next" class="primary">再来一批</button>
      <button id="home" class="secondary">返回首页</button>
    </div>`;
  $('#next').onclick=()=>startFlow(CFG.mode,true);
  $('#home').onclick=renderHome;
}

/* =================================================================
 *                     ⚔  对  战  专  区  ⚔
 * ================================================================= */
const PK_TIME = 5;            // 每题秒数
let pk = { idx:0, score:0, correct:0,  // 本地成绩
           oppIdx:0, oppScore:0,       // 对手进度
           timer: null, timeLeft: PK_TIME };

function pkFlow(){
  CFG.bank=$('#bank').value;
  CFG.batch=parseInt($('#batch').value,10);
  CFG.mode='pk';
  const room = prompt('输入房间号：'); if(!room) return;
  CFG.roomId = room;

  if(!socket) socket = io();
  socket.off();
  socket.emit('join-room',{ roomId:room, bank:CFG.bank, batch:CFG.batch });
  renderWaiting();

  socket.on('waiting', renderWaiting);

  /* ① 开始对战 */
  socket.on('start', async (cfg)=>{
    await loadWordbank(cfg.bank);
    buildPkRounds(room);          // 题目顺序双方一致
    CFG.t0 = performance.now();   // ⬅️ 记录开局时间（关键）
    pk.idx=pk.score=pk.correct=0;
    pk.oppIdx=pk.oppScore=0;
    renderPkQuiz();
  });

  /* ② 对方进度 */
  socket.on('progress', ({ id, idx, score })=>{
    pk.oppIdx   = idx;
    pk.oppScore = score;
    updateScoreboard();
  });

  /* ③ 结果 */
  socket.on('result', showPkResult);

  socket.on('opponent-left', ()=>{ alert('对手离开'); renderHome(); });
  socket.on('join-error',  m=>{ alert(m); renderHome(); });
}

/* ---------- 构题（双方同序） ---------- */
function seededShuffle(arr, seed){
  const rng = seedrandom(seed);
  return [...arr].sort(()=>rng()-.5);
}
function buildPkRounds(seed){
  const words = seededShuffle([...wordbank], seed).slice(0, CFG.batch);
  rounds = words.map(w=>{
    // 为确保一致，固定题型：英文 → 中文（40%）、中文 → 英文（40%）、音频 → 中文（20%）
    const roll = (seed.charCodeAt(0) + w.en.length) % 10;
    let q,a,qType='text', field;
    if(roll < 4){ q=w.en; a=w.zh; field='zh'; }
    else if(roll < 8){ q=w.zh; a=w.en; field='en'; }
    else { q='🔊'; a=w.zh; qType='audio'; field='zh'; }

    return { word:w, question:q, answer:a, qType,
             choices: seededShuffle([a, ...randomPick(field, a, 3)], seed + w.en) };
  });
}

/* ---------- 界面渲染 ---------- */
function renderPkQuiz(){
  if(pk.idx >= rounds.length){
    clearInterval(pk.timer);
    const time = Math.round(performance.now() - CFG.t0);
    socket.emit('finish',{ roomId:CFG.roomId, score:pk.score,
                           time, correct:pk.correct });
    app.innerHTML='<p class="center">已提交成绩，等待对手…</p>';
    return;
  }

  const r = rounds[pk.idx];
  pk.timeLeft = PK_TIME;

  $('#view').innerHTML = `
    <div class="scoreboard">
      <div>你：<span id="myScore">0</span></div>
      <div>对手：<span id="opScore">0</span></div>
    </div>

    <div id="countdown">
      <svg width="110" height="110">
        <circle id="ringBg"  cx="55" cy="55" r="50" stroke="#37474f"></circle>
        <circle id="ringBar" cx="55" cy="55" r="50" stroke="#1e88e5" stroke-dasharray="314" stroke-dashoffset="0"></circle>
      </svg>
      <div id="countNum">${PK_TIME}</div>
    </div>
    <div class="question">${r.qType==='audio'?`<button id="play">▶️</button>`:r.question}</div>
    <div class="options">
      ${r.choices.map(c=>`<button>${c}</button>`).join('')}
    </div>`;

  if(r.qType==='audio'){
    const audio=new Audio(r.word.audio); audio.play();
    $('#play').onclick=()=>new Audio(r.word.audio).play();
  }
  $('.options').querySelectorAll('button').forEach(btn=>{
    btn.onclick=()=>pkJudge(btn,r,false);
  });

  startCountdown();
  updateScoreboard();
}

function startCountdown(){
  clearInterval(pk.timer);
  const circle = $('#ringBar');
  const totalLen = 314;          // 2πr
  const step = totalLen / PK_TIME;
  pk.timeLeft = PK_TIME;
  $('#countNum').textContent = PK_TIME;
  circle.style.strokeDashoffset = 0;

  pk.timer = setInterval(()=>{
    pk.timeLeft--;
    $('#countNum').textContent = pk.timeLeft;
    circle.style.strokeDashoffset = step*(PK_TIME - pk.timeLeft);
    if(pk.timeLeft===0){
      pkJudge(null, rounds[pk.idx], true);
    }
  },1000);
}


function updateScoreboard(){
  $('#myScore').textContent = pk.score;
  $('#opScore').textContent = pk.oppScore;
}

/* ---------- 判题 ---------- */
function pkJudge(btn,r,timeout){
  clearInterval(pk.timer);

  const correct = !timeout && btn && btn.textContent===r.answer;
  if(btn) btn.classList.add(correct?'correct':'wrong');
  if(!correct){
    // 显示正确答案
    const ansBtn=[...$('.options').children].find(b=>b.textContent===r.answer);
    ansBtn.classList.add('correct');
  }
  pk.idx++;
  if(correct){ pk.score+=10; pk.correct++; }

  socket.emit('progress',{ roomId:CFG.roomId, idx:pk.idx, score:pk.score });

  setTimeout(renderPkQuiz, 600);
}

/* ---------- 结算界面 ---------- */
function showPkResult({ winner, detail }){
  clearInterval(pk.timer);
  const me   = detail.find(d=>d.id===socket.id);
  const opp  = detail.find(d=>d.id!==socket.id);
  const msg  = winner==='draw' ? '🤝 平局' :
               winner===socket.id ? '🎉 你赢了！' : '😢 你输了';

  app.innerHTML = `
    <div class="result-card">
      <h2>${msg}</h2>
      <table style="width:100%;margin:1rem 0;text-align:center">
        <tr><th></th><th>你</th><th>对手</th></tr>
        <tr><td>得分</td><td>${me.score}</td><td>${opp.score}</td></tr>
        <tr><td>正确</td><td>${me.correct}</td><td>${opp.correct}</td></tr>
        <tr><td>用时(s)</td><td>${(me.time/1000).toFixed(1)}</td><td>${(opp.time/1000).toFixed(1)}</td></tr>
      </table>
      <button id="home" class="primary">返回首页</button>
    </div>`;
  $('#home').onclick = renderHome;
}
