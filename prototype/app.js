import{store,emptyTaskDraft,saveAgentSession,loadAgentSession,clearAgentSession}from'./store.js';import{adapter}from'./adapter.js';import{labelsFor,capabilityLabel,actionLabel}from'./domain-labels.js';
const app=document.querySelector('#app'),modal=document.querySelector('#modalRoot'),toastEl=document.querySelector('#toast');const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const CHAT_BOTTOM_THRESHOLD=96;
let chatFollowsLatest=true,chatSavedScrollTop=0;
const fmt=s=>s?new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(s)):'—';
function toast(t){toastEl.textContent=t;toastEl.classList.add('show');setTimeout(()=>toastEl.classList.remove('show'),1800)}
// inline SVG 图标（引用 index.html 中的 symbol），跟随 currentColor。装饰性图标 aria-hidden。
const icon=(name,cls='icon')=>`<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
// ── 定稿文案（唯一来源：docs/copy/自动帮办话术.md 第12节，取「定稿」主用法） ──
const COPY={
  intro:{title:'那些琐碎的小事，我可以帮你盯着',body:'发通知、收文件、改名字、做登记，到点我也能提醒你。跟我说一次，之后我就照你的意思一直帮你办。',primary:'知道了',secondary:'先看看能帮我什么',exampleTitle:'这些事，我都可以替你办',examples:['帮你把作业发出去，再把交上来的收好','收到消息帮你回一句，并顺手记下来','到点帮你把通知或文件发出去','收到文件帮你改好名字、登记好'],exampleHint:'挑一件你常做的事，我先跟你确认从什么时候开始，再一步步问清楚要怎么做，你不用一次填一堆。'},
  inputPlaceholder:'说说想让我帮你做点什么，比如「帮我收作业」',
  capsuleLabel:'让我搭把手',
  keywordHint:{text:'这件事我可以帮你盯着，要不要我带你设一下？',confirm:'好，带我设',dismiss:'先不用'},
  reply:{collect:'好，这事交给我。我先跟你确认几个小地方，之后收上来的我都帮你归置好。',record:'可以，我来帮你记。你说清楚记哪些，之后我替你一条条登记好。',remind:'好，到点我来提醒。你告诉我什么时候、提醒谁，我帮你记着。',schedule:'好，到点我帮你发。你说清楚发什么、发到哪、几点发，之后我照做。',clarify:'没关系，说个大概就行。你是想让我帮你收东西、做登记，还是到点提醒你？'},
  empty:{title:'还没有交给我的事',body:'挑一件你常做的事交给我，我一步步问你从什么时候开始、要怎么做。',action:'交给我一件事'},
  feedback:{enabled:'好，条件到了我就帮你办。',disabled:'好，我先停一下，不会再自己开始了。正在办的这一次，我会帮你做完。',saved:'改好了，下次我就按新的来帮你办。',deleteTitle:'不再让我办这件事了？',deleteBody:'删掉之后我就不再办这件事，也不会出现在列表里。之前办过的记录和作业记录我都帮你留着。',deleted:'好，这件事我不再管了。之前的记录还在，随时能看。',saveFailed:'这次没帮你存上，你填的都还在，再试一下。'},
  handoff:{afterA:'这条我帮你记下了。要不要顺手把「收到作业时的登记」也交给我？',afterB:'这条也帮你记下了。到截止那天，还没交的人要不要我帮你提醒一下？',afterC:'都帮你记下了，一共三件事都交给我了。你随时能在「我的自动帮办」里开关、改动，或看看办得怎么样。'}
};
function route(r,data={}){store.update(s=>{s.ui.route=r;Object.assign(s.ui,data)});render()}
function header(title,sub='',actions=''){return`<header class="page-head"><div>${sub?`<p>${sub}</p>`:''}<h1>${title}</h1></div><div class="toolbar">${actions}</div></header>`}
// 首页 = 对话流（主入口）。输入框发消息、本地助手在对话流内应答，不跳页。
function renderHome(){
  const chat=store.get().chat;
  const placeholder=chat.some(message=>message.from==='me')?'':COPY.inputPlaceholder;
  const bubbles=chat.map(m=>{
    const quick=m.quick&&m.quick.length?`<div class="quick">${m.quick.map(q=>`<button class="chip" data-quick="${esc(q.action)}">${esc(q.label)}</button>`).join('')}</div>`:'';
    return`<div class="msg-row ${m.from==='me'?'me':''}"><span class="msg-avatar ${m.from==='me'?'me':'bot'}" aria-hidden="true">${m.from==='me'?'演':'助'}</span><div class="msg-bubble">${esc(m.text)}${quick}</div></div>`;
  }).join('');
  return`<section class="page home">${header('本地助手','该对话仅自己可见')}
  <div class="content" id="chatScroll"><div class="chat" id="chatFlow" role="log" aria-live="polite" aria-label="与本地助手的对话">${bubbles}</div>
    <div id="stepOptions">${agentOptionsHtml()}</div>
  </div>
  ${chatFollowsLatest?'':`<button class="latest-message" data-scroll-latest aria-label="回到最新消息">↓ 回到最新</button>`}
  <div class="composer"><div id="keywordTip"></div>
    <button class="auto-pill" data-action="assist-start">${icon('clock','icon icon-sm')} ${COPY.capsuleLabel}</button>
    <textarea id="messageInput" placeholder="${esc(placeholder)}" aria-label="给本地助手发消息"></textarea>
    <div class="composer-bottom">
      <span class="composer-tools"><button aria-label="添加">${icon('plus','icon icon-sm')}</button><button aria-label="表情">${icon('emoji','icon icon-sm')}</button><button aria-label="文件">${icon('file','icon icon-sm')}</button></span>
      <button class="send" id="sendBtn" aria-label="发送" ${store.get().agent.busy?'disabled':''}>${icon('send','icon icon-sm')}</button>
    </div>
  </div></section>`;
}
// 本地规则应答（本轮不做 NLU）。识别几类常见意图并在对话流内承接；
// 「设置/自动帮办」类意图给出承接点（引导到对话式创建），为阶段三留位。
function botReplyFor(text){
  const t=text.trim();
  if(/收.*作业|收作业|发作业|布置作业|收.*文件|自动|定时|每次|以后|提醒|催|登记/.test(t))
    return{text:'这类小事都可以交给我。我们一条一条来：先设「什么时候开始、发到哪个群」，建好发布后，再问要不要收到文件时帮你登记，最后看要不要到点提醒。现在开始设置吗？',quick:[{label:'开始设置',action:'create'},{label:'先看看我的自动帮办',action:'go-automations'}]};
  if(/你好|在吗|hi|hello|谁|会做什么|能做什么|帮我做什么/i.test(t))
    return{text:'我可以帮你把这些小事接过来：发通知、收文件并改名登记、到点提醒还没交的人。你想从哪件开始？',quick:[{label:'发作业并收作业',action:'create'}]};
  return{text:'我先记下了。这些小事我都能帮你：发通知、收文件登记、到点提醒。要我带你设一条吗？',quick:[{label:'开始设置',action:'create'}]};
}
// 发送用户消息并追加 本地助手应答（都在对话流内）。
async function sendMessage(){
  const input=document.querySelector('#messageInput');if(!input)return;
  const text=input.value.trim();if(!text)return;
  input.value='';
  if(/催交|提醒未交|催一下|催.*作业|作业.*催/.test(text)){
    const candidates=adapter.listAutomations().filter(a=>a.status==='enabled'&&a.capabilities?.includes('collect'));
    if(candidates.length===1){pushMe(text);await remindNow(candidates[0].automationId);return;}
  }
  if(store.get().agent.active){await agentSendText(text);return;}
  if(/收|发|提醒|登记|自动|定时|日报|单据|报销|作业|文件/.test(text)){
    pushMe(text);await agentStart(text);return;
  }
  const reply=botReplyFor(text);
  store.update(s=>{s.chat.push({from:'me',text});s.chat.push({from:'bot',text:reply.text,quick:reply.quick})});
  const tip=document.querySelector('#keywordTip');if(tip)tip.innerHTML='';
  requestAnimationFrame(()=>{const ni=document.querySelector('#messageInput');if(ni)ni.focus();});
}
// ============================================================================
// 对话式创建外壳（阶段三，规则驱动，非 NLU）
// 全程在首页对话流内，输入框常驻；选项以输入框上方的编号轻列表呈现，可点可打字。
// creation.phase=null 表示"待用户表达意图"，绝不默认 publish。
// ============================================================================
// 各链路每步的问句（本地助手气泡）。intent 为待意图阶段。
const CREATION={
  intent:{ask:'想让我帮你做点什么？可以直接说，也可以点下面的。',
    options:[
      {label:'收到文件帮我登记，并催还没交的人',intent:'publish'},
      {label:'收到消息帮我回一句并记下来',intent:'record'},
      {label:'到点帮我发通知或文件',intent:'schedule'},
      {label:'收到文件帮我改好名字再登记',intent:'collect'},
      {label:'我自己说',intent:'freeform'}
    ]},
  publish:['先定一下，什么时候开始发布作业？','__triggerFollow__','把作业发到哪个群？','要发送什么通知？','选择要一起发送的作业文件。','这条我先按这样建好，确认一下。'],
  collect:['收到什么文件时开始处理？','收到后按什么格式改名？','登记好之后，要回复发送人什么？','这条我先按这样建好，确认一下。'],
  remind:['什么时候检查未交名单并提醒？','要给未交同学发送什么提醒？','这条我先按这样建好，确认一下。']
};
// 每步的可点选项（编号轻列表）：多数步都给"推荐默认"直选 + "我自己填"，尽量少让用户打字。
// 返回 [{label, choice}]；choice 形如 set:字段:值 | ask:字段（转打字）| trigger:xx | text:xx。
function stepOptionList(){
  const c=store.get().creation,d=store.get().draft;if(!c.active||c.awaiting==='intent'||c.awaiting==='confirm')return null;
  const p=c.phase,step=c.step;
  if(p==='publish'){
    if(step===0)return[{label:'我发出约定消息时',choice:'trigger:self_message'},{label:'到设定时间',choice:'trigger:scheduled'}];
    if(step===1)return d.triggerMode==='scheduled'
      ?[{label:'今天 10:00',choice:'set:publishAt:2026-07-21T10:00:00+08:00'},{label:'今天 18:00',choice:'set:publishAt:2026-07-21T18:00:00+08:00'},{label:'明天 09:00',choice:'set:publishAt:2026-07-22T09:00:00+08:00'}]
      :[{label:`就用「${esc(d.keyword)}」`,choice:`set:keyword:${d.keyword}`},{label:'我自己定一句话',choice:'ask:keyword'}];
    if(step===2){const groups=store.get().groups||[];return[...groups.map(g=>({label:g.name||g.groupId,choice:`group:${g.groupId}`})),{label:'发到别的群',choice:'ask:groupId'}];}
    if(step===3)return[{label:'用默认通知内容',choice:`set:notice:${d.notice}`},{label:'我自己写通知',choice:'ask:notice'}];
    if(step===4)return[{label:'用默认作业文件',choice:`set:filePath:${d.filePath}`},{label:'我自己选文件',choice:'ask:filePath'}];
  }
  if(p==='collect'){
    if(step===0)return[{label:'收到 .docx / .pdf 文件时（推荐）',choice:'set:fileKeyword:作业'},{label:'我自己指定',choice:'ask:fileKeyword'}];
    if(step===1)return[{label:'用「学号_姓名」（推荐）',choice:'set:nameTemplate:{studentId}_{name}{originalExtension}'},{label:'我自己定格式',choice:'ask:nameTemplate'}];
    if(step===2)return[{label:'回「收到，已帮你登记」（推荐）',choice:'set:replyText:收到，已帮你登记'},{label:'我自己写回复',choice:'ask:replyText'}];
  }
  if(p==='remind'){
    // A2 彻底档：提醒时间独立（remindAt），不再强制=截止时间。给几个常用时点直选 + 自定义。
    if(step===0){
      const caps=store.get().creation.capabilities||[];
      const opts=[{label:'今天 18:00 提醒',choice:'set:remindAt:2026-07-25T18:00:00+08:00'},{label:'明天 09:00 提醒',choice:'set:remindAt:2026-07-22T09:00:00+08:00'},{label:'我自己定时间',choice:'ask:remindAt'}];
      if(caps.includes('collect'))opts.unshift({label:'到截止时间就提醒（推荐）',choice:`set:remindAt:${d.deadlineAt}`});
      return opts;
    }
    if(step===1)return[{label:'用默认提醒文案',choice:`set:reminderText:${d.reminderText}`},{label:'我自己写提醒',choice:'ask:reminderText'}];
  }
  return null;
}
// 当前步的选项（编号轻列表）。返回 [{label, choice}] 或 null（该步用文本作答）。
function creationStepOptions(){
  const c=store.get().creation;if(!c.active)return null;
  if(c.awaiting==='intent')return CREATION.intent.options.map(o=>({label:o.label,choice:`intent:${o.intent}`}));
  if(c.awaiting==='confirm')return null; // 确认卡单独渲染
  if(c.awaiting==='text')return null;    // 用户选了"我自己填"，改用输入框
  return stepOptionList();
}
// 渲染输入框上方的编号轻列表 + 确认卡。
function creationOptionsHtml(){
  const c=store.get().creation;if(!c.active)return'';
  if(c.awaiting==='confirm')return confirmCardChat(c.phase);
  const opts=creationStepOptions();if(!opts)return'';
  return`<div class="step-options" role="group" aria-label="可选项，也可直接在下方输入框回答">${opts.map((o,i)=>`<button class="step-opt" data-step-choice="${esc(o.choice)}"><span class="step-opt-num">${i+1}</span><span>${esc(o.label)}</span></button>`).join('')}</div>`;
}
// 当前应展示的问句文本（用于把 本地助手提问 push 成气泡）。
function creationQuestionText(){
  const c=store.get().creation,d=store.get().draft;
  if(c.awaiting==='intent')return CREATION.intent.ask;
  let q=CREATION[c.phase]&&CREATION[c.phase][c.step];
  if(q==='__triggerFollow__')q=d.triggerMode==='scheduled'?'几点开始发？（例如 周五 18:00）':'你发出哪句话时开始？';
  return q||'';
}
// A2 彻底档：意图 → capabilities（按需组合），决定要建哪几条、走哪几段问答。
// 不再无论什么意图都强拉成固定三条。
function capabilitiesForIntent(intent){
  if(intent==='publish')return['publish','collect','remind']; // 收作业并催交=完整闭环
  if(intent==='schedule')return['publish'];                    // 到点发通知=只发布
  if(intent==='collect'||intent==='record')return['collect'];  // 收文件登记 / 收消息记 = 只登记
  if(intent==='remind')return['remind'];                       // 只提醒
  return['publish','collect','remind'];
}
// 按意图设定能力序列并进入第一条能力的问答。
function creationStartPlan(intent){
  const caps=capabilitiesForIntent(intent);
  store.update(s=>{s.creation.intent=intent;s.creation.capabilities=caps;s.creation.planIndex=0;});
  creationEnterPhase(caps[0]);
}
// 进入某条能力的问答：置 phase，step=0，awaiting 由该步决定，并 push 第一问。
function creationEnterPhase(phase){
  store.update(s=>{s.creation.phase=phase;s.creation.step=0;s.creation.askField=null;});
  creationSyncAwaiting();
  pushBot(phaseTitle(phase)+'　'+creationQuestionText());
}
// 能力标题：按当前能力序列动态编号 + 措辞跟意图（修「选定时却说发布作业」串场）。
function phaseTitle(p){
  const c=store.get().creation;const caps=c.capabilities&&c.capabilities.length?c.capabilities:[p];
  const label=p==='publish'?(c.intent==='schedule'?'定时发送通知':'发布通知'):p==='collect'?'收取并登记':'到点提醒';
  if(caps.length<=1)return '这条帮办 · '+label;                 // 单条：不叫「第N条」
  const ordinal=['第一条','第二条','第三条'][caps.indexOf(p)]||'这条';
  return ordinal+' '+label;
}
// 根据当前步同步 awaiting（有选项=choice，确认步=confirm，否则=text）。
function creationSyncAwaiting(){
  store.update(s=>{const c=s.creation;const isLast=CREATION[c.phase]&&c.step===CREATION[c.phase].length-1;
    if(isLast){c.awaiting='confirm';return;}
    c.awaiting='choice'; // 每步默认给选项；用户点"我自己填"时再切到 text
  });
}
function pushBot(text,quick){store.update(s=>s.chat.push({from:'bot',text,...(quick?.length?{quick}:{})}));}
function pushMe(text){store.update(s=>s.chat.push({from:'me',text}));}
function clearReminderQuick(automationId){store.update(s=>{for(const message of s.chat)if(message.quick?.some(item=>item.action.endsWith(automationId)))delete message.quick})}
async function remindNow(automationId){
  clearAgentSession();store.update(s=>{s.agent={active:false,busy:false,draftId:null,conversationId:null,draft:null,error:null}});
  try{const result=await adapter.remindAutomationNow(automationId);pushBot(result.sentCount?`已提醒${result.sentCount}名未交成员。`:'这项作业现在没有未交成员，不需要催交。')}
  catch(error){pushBot(error.message||'这次没能发出催交，请重试。')}
}
async function promptDeadlineCheck(){
  const automationId=store.get().ui.selectedAutomationId;if(!automationId)throw new Error('请先选择一个收作业任务');
  const check=await adapter.checkAutomationDeadline(automationId);
  const names=check.missingMembers.map(member=>member.name).slice(0,5).join('、');
  const text=check.missingCount
    ?`「${check.taskName}」已到截止检查时间，还有${check.missingCount}人没交${names?`，分别是${names}`:''}。需要我现在帮你催交吗？`
    :`「${check.taskName}」已到截止检查时间，所有人都交齐了，不需要催交。`;
  store.update(s=>{s.ui.route='home';s.chat.push({from:'bot',text,...(check.missingCount?{quick:[{label:'帮我催交',action:`remind-now:${automationId}`},{label:'暂不催交',action:`dismiss-remind:${automationId}`}]}:{})})});
}
// 处理一次"作答"（点选项或打字），推进状态机。value 为文本或 choice。
function creationAnswer(raw,isChoice){
  const c=store.get().creation;
  // 意图阶段
  if(c.awaiting==='intent'){
    let intent=isChoice?raw.split(':')[1]:matchIntent(raw);
    if(isChoice)pushMe(CREATION.intent.options.find(o=>o.intent===intent)?.label||raw);else pushMe(raw);
    if(intent==='publish'){creationStartPlan('publish');return}
    if(intent==='collect'){pushBot(COPY.reply.collect);creationStartPlan('collect');return}
    if(intent==='schedule'){pushBot(COPY.reply.schedule);store.update(s=>s.draft.triggerMode='scheduled');creationStartPlan('schedule');return} // 定时发通知=只建发布，触发默认到设定时间
    if(intent==='record'){pushBot(COPY.reply.record);creationStartPlan('collect');return} // 收消息回复并登记 → 只登记
    if(intent==='freeform'){pushBot(COPY.reply.clarify);return}
    // 意图不清
    pushBot(COPY.reply.clarify);return;
  }
  // 点选项作答
  if(isChoice){
    // 触发方式
    if(raw.startsWith('trigger:')){const mode=raw.split(':')[1];store.update(s=>s.draft.triggerMode=mode);pushMe(mode==='scheduled'?'到设定时间':'我发出约定消息时');advanceStep();return;}
    // 选群等固定值
    if(raw.startsWith('group:')){const groupId=raw.slice(6);store.update(s=>s.draft.groupId=groupId);pushMe(groupDisplayName(groupId));advanceStep();return;}
    // 采用推荐默认值：set:字段:值
    if(raw.startsWith('set:')){const rest=raw.slice(4),i=rest.indexOf(':'),field=rest.slice(0,i),val=rest.slice(i+1);
      if(field&&field!=='__noop__')store.update(s=>s.draft[field]=val);
      // 回显用户选择的标签（取当前选项 label）
      const opt=(stepOptionList()||[]).find(o=>o.choice===raw);pushMe(opt?opt.label:'好');advanceStep();return;}
    // 用户选择"我自己填"：ask:字段 → 切到打字，提示在输入框输入
    if(raw.startsWith('ask:')){const field=raw.slice(4);store.update(s=>{s.creation.awaiting='text';s.creation.askField=field;});
      pushMe('我自己填');pushBot('好，你在下面直接输入就行。');return;}
  }
  // 打字作答（用户在输入框输入）：写入当前 askField 对应字段
  const c2=store.get().creation;
  let field=c2.askField||phaseFieldAt(c2.phase,c2.step);
  if(field&&c2.phase==='publish'&&c2.step===0){ // 触发方式步打字
    const mode=/时间|定时|到点|几点|周|号/.test(raw)?'scheduled':'self_message';store.update(s=>s.draft.triggerMode=mode);pushMe(raw);store.update(s=>s.creation.askField=null);advanceStep();return;
  }
  if(field==='groupId')store.update(s=>s.draft.groupId=raw);
  else if(field)store.update(s=>s.draft[field]=raw);
  store.update(s=>s.creation.askField=null);
  pushMe(raw);advanceStep();
}
// 各 phase/step 对应写入的 draft 字段（触发语、通知、文件、改名、回复、提醒等）。
function phaseFieldAt(p,step){
  if(p==='publish'){const d=store.get().draft;if(step===1)return d.triggerMode==='scheduled'?'publishAt':'keyword';if(step===3)return'notice';if(step===4)return'filePath';}
  if(p==='collect'){if(step===0)return'fileKeyword';if(step===1)return'nameTemplate';if(step===2)return'replyText';}
  if(p==='remind'){if(step===0)return'remindAt';if(step===1)return'reminderText';}
  return null;
}
// 推进到下一步；到确认步则出确认卡；确认步之后由确认卡按钮驱动。
function advanceStep(){
  store.update(s=>{s.creation.step++;s.creation.askField=null;});
  creationSyncAwaiting();
  const c=store.get().creation;
  if(c.awaiting==='confirm'){pushBot('好，这条我先按这样建好。你看没问题的话，我就记下来。');return;}
  pushBot(creationQuestionText());
}
// 最小意图识别（规则，非 NLU）：仅按关键词粗分方向。
function matchIntent(t){
  if(/收.*作业|发作业|布置作业|收作业/.test(t))return'publish';
  if(/改名|重命名|文件.*登记|收.*文件/.test(t))return'collect';
  if(/回复|回一句|登记.*回复|记.*回复/.test(t))return'record';
  if(/定时|到点|每天|每周|准时|按时.*发/.test(t))return'schedule';
  return null;
}
// 群标识 → 显示名（跟随 draft，不写死班级名，避免措辞串场）。
function groupDisplayName(groupId){const g=(store.get().groups||[]).find(x=>x.groupId===groupId);return g?g.name:(groupId||'目标群');}
// 确认卡（对话流内），五个按钮齐全 + 效果化摘要（零技术词，措辞跟数据与意图走）。
function confirmCardChat(p){
  const d=store.get().draft;
  const gname=esc(groupDisplayName(d.groupId));
  const summary=p==='publish'
    ?(d.triggerMode==='scheduled'?`到设定时间，我把通知和文件发到${gname}。`:`当你发出「${esc(d.keyword)}」时，我把通知和文件发到${gname}。`)
    :p==='collect'?`${gname}收到符合规则的文件后，我确认提交人、按格式改名并登记，完成后回复发送人。`
    :`到设定的提醒时间，我从记录里找出还没交的人，向他们发送同一段提醒。`;
  return`<div class="confirm-card"><h3>${phaseTitle(p)}</h3><p>${summary}</p>
  <div class="confirm-actions">
    <button class="btn primary" data-cc="enable">确认并启用</button>
    <button class="btn" data-cc="disable">暂不启用</button>
    <button class="btn" data-cc="edit">修改</button>
    <button class="btn" data-cc="back">返回上一步</button>
    <button class="btn ghost" data-cc="cancel">取消这条帮办</button>
  </div></div>`;
}
// 确认卡按钮处理。A2 彻底档：确认后推进能力序列；走完最后一条时一次性调真实
// createAutomationTask（唯一 ID 落库、按 capabilities 建对应条数），不再逐条覆盖固定 demo。
async function creationConfirm(action){
  const c=store.get().creation,p=c.phase;
  if(action==='back'){store.update(s=>{s.creation.step=Math.max(0,s.creation.step-1);});creationSyncAwaiting();pushBot(creationQuestionText());return;}
  if(action==='edit'){store.update(s=>{s.creation.step=0;});creationSyncAwaiting();pushBot('好，我们重新过一遍这条。'+creationQuestionText());return;}
  if(action==='cancel'){pushBot('好，这条先不建了。还想让我帮你做点别的吗？');store.update(s=>{s.creation.phase=null;s.creation.awaiting='intent';s.creation.step=0;s.creation.capabilities=[];s.creation.planIndex=0;});pushBot(CREATION.intent.ask);return;}
  // 守卫：发布用「到设定时间」时，publishAt 必须合法 RFC3339，否则回退默认合法时间。
  if(p==='publish'&&store.get().draft.triggerMode==='scheduled'){
    const RFC=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
    if(!RFC.test(store.get().draft.publishAt||''))store.update(s=>s.draft.publishAt='2026-07-21T10:00:00+08:00');
  }
  const caps=c.capabilities&&c.capabilities.length?c.capabilities:[p];
  const idx=caps.indexOf(p);
  const isLastCap=idx>=caps.length-1;
  if(!isLastCap){
    // 还有下一条能力：承接语 + 进入下一条问答。此时不落库，等最后统一建。
    const next=caps[idx+1];
    pushBot(next==='collect'?COPY.handoff.afterA:next==='remind'?COPY.handoff.afterB:'这条我先记下了，接着看下一条。');
    store.update(s=>{s.creation.planIndex=idx+1;});
    creationEnterPhase(next);
    return;
  }
  // 最后一条：一次性真实创建（按 capabilities 建对应条数，唯一 ID 落库）。
  try{
    const {result,pendingWiring}=await adapter.createAutomationTaskFromDraft(caps,store.get().draft);
    if(pendingWiring)pushBot('内容我都检查好了，真实创建通道接通后即可保存生效。');
    else pushBot(caps.length>=3?COPY.handoff.afterC:'好，这件事我帮你建好了，随时能在「我的自动帮办」里开关或查看。');
  }catch(err){
    if(err&&err.name==='CreationValidationError'){pushBot('还差一点信息我才能建好：'+err.errors.map(e=>e.message).join('；'));return;}
    console.error('创建失败',err);pushBot('这条这次没帮你存上，稍后再试一下。');return;
  }
  store.update(s=>{s.creation.active=false;s.creation.phase=null;s.creation.awaiting=null;s.creation.step=0;s.creation.capabilities=[];s.creation.planIndex=0;});
}

// P1-B B3。服务端草稿是唯一权威，浏览器只在当前页面内保留访问凭据。
const CONTROLLED_FIELDS=new Set(['groupId','noticeFilePath','publishTrigger','collectRule','nameTemplate','roster','replyText','remindText','submitters','stores']);
const TIME_FIELDS=new Set(['publishAt','deadlineAt','remindAt']);
const capabilityText={publish:'发送通知或文件',collect:'收取并登记',remind:'检查缺失并提醒'};
const domainText={education:'教学协作',finance:'财务单据',retail:'门店日报'};
const fieldText={taskName:'帮办名称',groupId:'处理范围',publishTrigger:'发送方式',publishKeyword:'触发消息',publishText:'发送内容',noticeFilePath:'发送文件',publishAt:'发送时间',collectRule:'收取规则',roster:'成员名单',remindText:'提醒内容',remindAt:'提醒时间',deadlineAt:'截止时间',submitters:'提交人清单',stores:'门店清单',nameTemplate:'文件命名方式',replyText:'回复内容'};
function agentAuth(){const a=store.get().agent;return{conversationId:a.conversationId,draftToken:a.draftToken}}
function uniqueCandidates(draft){
  const seen=new Set();
  return(draft?.candidateUnderstandings||[]).filter(c=>{const key=`${c.domain}|${c.goal}|${c.capabilities.join(',')}`;if(seen.has(key))return false;seen.add(key);return true});
}
function localDateValue(days=1,hour=18){
  const d=new Date();d.setDate(d.getDate()+days);d.setHours(hour,0,0,0);
  const pad=n=>String(n).padStart(2,'0');
  return`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function localValueFromRfc3339(value){
  const d=new Date(value);if(Number.isNaN(d.getTime()))return null;
  const pad=n=>String(n).padStart(2,'0');
  return`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function agentTimeDefault(field,draft){
  const bindings=draft?.planSpec?.bindings||{};
  if(field==='publishAt')return localDateValue(1,10);
  if(field==='deadlineAt'&&bindings.remindAt)return localValueFromRfc3339(bindings.remindAt)||localDateValue(3,18);
  if(field==='remindAt'&&bindings.deadlineAt)return localValueFromRfc3339(bindings.deadlineAt)||localDateValue(3,18);
  return localDateValue(3,18);
}
function toRfc3339(local){
  const d=new Date(local);if(Number.isNaN(d.getTime()))throw new Error('请选择明确日期和时间');
  const off=-d.getTimezoneOffset(),sign=off>=0?'+':'-',pad=n=>String(Math.abs(n)).padStart(2,'0');
  return`${local}:00${sign}${pad(Math.trunc(off/60))}:${pad(off%60)}`;
}
function trustedChoices(field){return(store.get().agent.contextOptions||[]).filter(option=>option.field===field)}
function customPicker(field,index){
  if(!['groupId','collectRule','nameTemplate','replyText','remindText'].includes(field))return'';
  const hint=field==='groupId'?'输入其他群名':field==='collectRule'?'输入其他文件类型，如xlsx（不限文件名）':field==='nameTemplate'?'输入格式，如{name}_{studentId}{originalExtension}':field==='remindText'?'输入其他催交文案':'输入其他回复内容';
  return`<div class="custom-choice"><span class="step-opt-num">${index}</span><input id="agentCustomValue" placeholder="${hint}" aria-label="${hint}"><button class="btn" data-agent-custom="${field}">使用</button></div>`;
}
function agentStatusNotice(a){
  if(a.error)return`<div class="agent-notice failed">${esc(a.error)} <button class="btn" data-agent-retry>重试</button></div>`;
  if(a.busy)return`<div class="agent-notice" role="status">正在整理这一步，请稍候…</div>`;
  const d=a.draft;if(d?.status==='unsupported')return'';
  if(d?.fallbackReason)return`<div class="agent-notice warn"><b>按明确规则识别</b><br>智能理解暂时不可用，我会按明确规则继续整理。请仔细核对确认内容。</div>`;
  return'';
}
function agentOptionsHtml(){
  const a=store.get().agent;if(!a.active)return'';
  const d=a.draft;
  let body=agentStatusNotice(a);
  if(!d||a.busy||a.error)return body;
  if(d.status==='ready_for_confirmation')return body+agentConfirmCard(d);
  if(d.status==='compiling')return body+`<div class="agent-notice">上次创建尚未完成，可以安全地继续。</div><button class="btn primary" data-agent-confirm>继续完成创建</button>`;
  if(d.status==='compiled')return body+`<div class="agent-notice">这件帮办已经创建完成。</div>`;
  if(d.status==='expired')return body+`<div class="agent-notice failed">这份设置已过期，没有启用任何帮办。<button class="btn" data-agent-restart>重新开始</button></div>`;
  if(d.status==='unsupported')return body+`<div class="agent-notice warn" role="status"><b>这件事目前还不能按你的原意完整办好。</b><br>我没有创建任何自动帮办，也没有发送消息或执行其他动作。你可以重新说一个目标，或者看看我现在能做什么。</div><div class="confirm-actions"><button class="btn primary" data-agent-redescribe>重新描述</button><button class="btn" data-examples>看看现在能做什么</button><button class="btn ghost" data-agent-cancel>取消设置</button></div>`;
  if(d.status==='awaiting_candidate'){
    const candidates=uniqueCandidates(d);
    if(candidates.length<2||candidates.length>4)return body+`<div class="agent-notice failed">我还不能确定你的意思，请重新描述。</div>`;
    return body+`<div class="candidate-list" role="group" aria-label="选择一种理解">${candidates.map((c,i)=>`<button class="step-opt" data-agent-candidate="${esc(c.candidateId)}"><span class="step-opt-num">${i+1}</span><span><b>${esc(c.goal)}</b><small>${esc(domainText[c.domain]||c.domain)} · ${c.capabilities.map(x=>capabilityText[x]||x).join('、')}${c.domain==='finance'?' · 收件后进入待审核清单，不代表审核通过':''}</small></span></button>`).join('')}</div><button class="btn ghost" data-agent-cancel>取消设置</button>`;
  }
  const q=d.pendingQuestion;if(!q)return body;
  if(CONTROLLED_FIELDS.has(q.field)){
    const choices=trustedChoices(q.field);
    const canCustomize=['groupId','collectRule','nameTemplate','replyText','remindText'].includes(q.field);
    const hint=canCustomize?'请选择一项，也可以填写自己的内容。':'请选择一项。';
    body+=`<div class="controlled-picker" role="group" aria-label="${esc(q.text)}"><p><b>${esc(q.text)}</b><span class="picker-hint">${hint}</span></p>${choices.length?choices.map((o,i)=>`<button class="step-opt" data-agent-trusted="${esc(o.optionId)}"><span class="step-opt-num">${i+1}</span><span>${esc(o.label)}</span></button>`).join(''):'<p>暂时没有可选内容，请先在对应页面准备好后再回来。</p>'}${customPicker(q.field,choices.length+1)}</div>`;
  }else if(TIME_FIELDS.has(q.field)){
    body+=`<div class="controlled-picker"><label>${esc(q.text)}<input id="agentTime" type="datetime-local" value="${agentTimeDefault(q.field,d)}" aria-label="${esc(q.text)}"></label><button class="btn primary" data-agent-time>使用这个时间</button></div>`;
  }else{
    body+=`<p class="agent-question">${esc(q.text)}</p>`;
  }
  body+=`<div class="confirm-actions"><button class="btn ghost" data-agent-cancel>取消设置</button></div>`;
  return body;
}
function extensionSummary(rule){return(rule?.allowedExtensions||[]).map(value=>String(value).replace(/^\./,'').toUpperCase()).join('、')||'所选类型'}
function collectRuleSummary(rule){const types=extensionSummary(rule);return rule?.keyword?`${types}文件且文件名包含“${rule.keyword}”`:`${types}文件`}
function nameTemplateSummary(template,domain){
  const id=domain==='finance'?'项目编号':domain==='retail'?'门店编号':'学号',name=domain==='finance'?'提交人':domain==='retail'?'门店名':'姓名';
  return String(template||'{studentId}_{name}{originalExtension}').replaceAll('{studentId}',id).replaceAll('{name}',name).replaceAll('{originalExtension}','原文件类型');
}
function agentConfirmCard(d){
  const p=d.planSpec,b=p.bindings||{},caps=p.capabilities||[];
  const group=b.groupId?groupDisplayName(b.groupId):'所选范围';
  const steps=[];
  if(caps.includes('publish'))steps.push({when:b.publishTrigger==='scheduled'?fmt(b.publishAt):`你发出“${b.publishKeyword}”后`,do:`把通知${b.noticeFilePath?'和文件':''}发送到${group}`});
  if(caps.includes('collect'))steps.push({when:`${group}收到${collectRuleSummary(b.collectRule)}后`,do:`按“${nameTemplateSummary(b.nameTemplate,p.domain)}”改名，${p.domain==='finance'?'收好单据并放入待审核清单':'核对成员并登记提交状态'}${b.replyText?`，随后回复“${b.replyText}”`:''}`});
  if(caps.includes('collect')&&b.deadlineAt)steps.push({when:fmt(b.deadlineAt),do:'检查未交名单，并先问你是否需要催交'});
  if(caps.includes('remind'))steps.push({when:fmt(b.remindAt),do:`找出未完成的人并发送提醒${b.remindText?`“${b.remindText}”`:''}`});
  const rows=steps.map((step,index)=>`<section class="automation-step"><span>${index+1}</span><div><small>${esc(step.when)}</small><b>${esc(step.do)}</b></div></section>`).join('');
  const editable=Object.keys(b).filter(field=>fieldText[field]);
  const revise=store.get().agent.showReviseFields
    ?`<div class="revise-picker"><p>选择要修改的内容</p>${editable.map(field=>`<button class="btn" data-agent-revise="${esc(field)}">${esc(fieldText[field])}</button>`).join('')}</div>`
    :'';
  return`<div class="confirm-card"><p class="confirm-eyebrow">启用前确认</p><h3>本地助手会这样帮你</h3><p class="confirm-task-name">${esc(b.taskName||'这条自动帮办')}</p>
  ${p.domain==='finance'?'<div class="agent-notice warn">财务单据只会收件并进入待审核清单，不会自动审核、付款或入账。</div>':''}
  <div class="automation-flow">${rows}</div><details class="run-details"><summary>查看运行说明</summary><p>${esc(p.approvalRequirements.join('；')||'涉及发送或持续执行时，会按已确认的范围运行。')}</p><p>启用后可以在自动帮办页暂停、恢复或修改。</p></details>
  ${revise}<div class="confirm-actions"><button class="btn primary" data-agent-confirm>启用这条帮办</button><button class="btn" data-agent-revise-menu>修改设置</button><button class="btn" data-agent-back>上一步</button><button class="btn ghost" data-agent-cancel>取消</button></div></div>`;
}
function agentErrorMessage(error){
  if(error.status===401)return'访问凭据已失效，请重新开始。';
  if(error.status===404)return'这份设置已不存在或无权访问，请重新开始。';
  if(error.status===409)return'设置刚刚发生变化，已为你恢复到最新状态。';
  return error.message||'这一步没有保存，请重试。';
}
async function withAgentBusy(work){
  if(store.get().agent.busy)return;
  store.update(s=>{s.agent.busy=true;s.agent.error=null});
  try{await work()}catch(error){
    const a=store.get().agent;
    if(error.status===409&&a.draftId){
      try{const latest=await adapter.getAgentDraft(a.draftId,agentAuth());await setAgentDraft(latest);pushBot(latest.status==='compiled'?'这件帮办已经创建完成。':'已恢复到最新内容。');return}catch(recoveryError){error=recoveryError}
    }
    if(error.status===401||error.status===404)clearAgentSession();
    store.update(s=>{s.agent.error=agentErrorMessage(error)})
  }
  finally{store.update(s=>{s.agent.busy=false})}
}
async function setAgentDraft(draft){
  const previousQuestion=store.get().agent.draft?.pendingQuestion;
  let contextOptions=[];
  if(draft&&!['compiled','cancelled','expired','unsupported'].includes(draft.status)){
    try{contextOptions=await adapter.agentContextOptions(draft.draftId,agentAuth())}catch{}
  }
  store.update(s=>{s.agent.draft=draft;s.agent.draftId=draft?.draftId||s.agent.draftId;s.agent.contextOptions=contextOptions;s.agent.error=null;s.agent.showReviseFields=false;if(draft?.status==='compiled'||draft?.status==='cancelled')s.agent.active=false});
  const nextQuestion=draft?.pendingQuestion;
  if(nextQuestion&&(!previousQuestion||previousQuestion.field!==nextQuestion.field||previousQuestion.text!==nextQuestion.text))pushBot(nextQuestion.text);
  if(['compiled','cancelled','expired'].includes(draft?.status))clearAgentSession();
}
async function agentStart(initialMessage){
  if(store.get().ui.route!=='home')route('home');
  await withAgentBusy(async()=>{
    const conversationId=`conversation_${crypto.randomUUID()}`;
    const created=await adapter.createAgentDraft(conversationId);
    const token=created.draftToken;delete created.draftToken;
    store.update(s=>{s.creation.active=false;s.agent={active:true,busy:true,draftId:created.draftId,conversationId,draftToken:token,draft:created,error:null}});
    saveAgentSession({draftId:created.draftId,conversationId,draftToken:token});
    if(initialMessage){
      const next=await adapter.messageAgentDraft(created.draftId,{message:initialMessage},{conversationId,draftToken:token});
      await setAgentDraft(next);
    }else pushBot('想让我帮你做点什么？请直接在下面输入。');
  });
}
async function agentSendText(text){
  const a=store.get().agent,d=a.draft;if(!d||a.busy)return;
  if(CONTROLLED_FIELDS.has(d.pendingQuestion?.field)||TIME_FIELDS.has(d.pendingQuestion?.field)){toast('这一项请使用上方的受控选择器');return}
  pushMe(text);
  await withAgentBusy(async()=>{
    const payload=d.revision===0||d.status==='unsupported'?{message:text}:{userAnswer:text};
    const next=await adapter.messageAgentDraft(d.draftId,payload,agentAuth());
    await setAgentDraft(next);
    if(!next.pendingQuestion&&next.status==='ready_for_confirmation')pushBot('信息已整理好，请检查确认卡。');
  });
}
async function agentSendTrusted(optionId){
  const d=store.get().agent.draft,choice=(store.get().agent.contextOptions||[]).find(option=>option.optionId===optionId);if(!choice)return;
  pushMe(`${fieldText[d.pendingQuestion?.field]||'已选择'}｜${choice.label}`);
  await withAgentBusy(async()=>{const next=await adapter.messageAgentDraft(d.draftId,{contextOptionIds:[optionId]},agentAuth());await setAgentDraft(next);if(!next.pendingQuestion&&next.status==='ready_for_confirmation')pushBot('信息已整理好，请检查确认卡。')});
}
async function agentSendCustom(field){
  const d=store.get().agent.draft,input=document.querySelector('#agentCustomValue');if(!d||d.pendingQuestion?.field!==field||!input)return;
  const value=input.value.trim();if(!value){toast('请先填写内容');input.focus();return}
  pushMe(`${fieldText[field]||'自定义内容'}｜${value}`);
  await withAgentBusy(async()=>{const next=await adapter.agentCustomContext(d.draftId,field,value,agentAuth());await setAgentDraft(next);if(!next.pendingQuestion&&next.status==='ready_for_confirmation')pushBot('信息已整理好，请检查确认卡。')});
}
async function agentSendTime(){
  const d=store.get().agent.draft,field=d?.pendingQuestion?.field,input=document.querySelector('#agentTime');if(!TIME_FIELDS.has(field)||!input)return;
  const value=toRfc3339(input.value);pushMe(`${fieldText[field]||'时间'}｜${fmt(value)}`);
  await withAgentBusy(async()=>{const next=await adapter.messageAgentDraft(d.draftId,{userAnswer:value},agentAuth());await setAgentDraft(next);if(!next.pendingQuestion&&next.status==='ready_for_confirmation')pushBot('信息已整理好，请检查确认卡。')});
}
async function agentChooseCandidate(candidateId){
  const d=store.get().agent.draft;
  await withAgentBusy(async()=>{const next=await adapter.chooseAgentCandidate(d.draftId,candidateId,agentAuth());await setAgentDraft(next)});
}
async function agentConfirm(){
  const d=store.get().agent.draft;
  await withAgentBusy(async()=>{const result=await adapter.confirmAgentDraft(d,agentAuth());pushBot(d.planSpec.domain==='finance'?'已建立。收到的单据只会进入待审核清单，这不代表审核通过。':'已建立并启用，你可以在自动帮办页暂停或修改。');clearAgentSession();store.update(s=>{s.agent.active=false;s.agent.draft=result.draft;delete s.agent.draftToken})});
}
async function agentCancel(message='已取消，这次不会创建任何自动帮办。'){
  const a=store.get().agent;if(!a.draft)return;
  await withAgentBusy(async()=>{await adapter.cancelAgentDraft(a.draft.draftId,agentAuth());clearAgentSession();store.update(s=>{s.agent={active:false,busy:false,draftId:null,conversationId:null,draft:null,error:null}});pushBot(message)});
}
async function agentBack(){
  const d=store.get().agent.draft;await withAgentBusy(async()=>setAgentDraft(await adapter.backAgentDraft(d.draftId,agentAuth())));
}
async function agentRevise(field){
  const d=store.get().agent.draft;await withAgentBusy(async()=>setAgentDraft(await adapter.reviseAgentDraft(d.draftId,field,agentAuth())));
}
async function restoreAgentSession(){
  const auth=loadAgentSession();if(!auth)return;
  store.update(s=>{s.agent={active:true,busy:true,draftId:auth.draftId,conversationId:auth.conversationId,draftToken:auth.draftToken,draft:null,error:null}});
  try{const draft=await adapter.getAgentDraft(auth.draftId,auth);await setAgentDraft(draft);if(draft.status==='compiled')pushBot('已恢复，这件帮办已经创建完成。')}
  catch(error){if(error.status===401||error.status===404)clearAgentSession();store.update(s=>{s.agent.error=agentErrorMessage(error)})}
  finally{store.update(s=>{s.agent.busy=false})}
}
// 任务级状态文案（面向用户，零技术词）。
const autoStatusText={enabled:'正在帮你盯着',paused:'已暂停',ended:'已结束',deleted:'已删除',draft:'待启用'};
const runText2={succeeded:'运行成功',succeeded_no_action:'成功但无动作',failed:'运行失败',running:'运行中'};
// P1-A：列表按「任务」聚合渲染，一个任务一张卡（不再把一个任务拆成三条 Flow）。
function renderList(){const list=adapter.listAutomations(),failed=adapter.unreadFailures();const active=list.filter(a=>a.status==='enabled').length;const totalRuns=list.reduce((n,a)=>n+(a.totalRuns||0),0);return`<section class="page">${header('我的自动帮办','本地助手',`<button class="btn" data-route="tech">内部技术视图</button><button class="btn primary" data-action="create">新建自动帮办</button>`)}<div class="content">${list.length?`<div class="summary"><div class="summary-card"><span>正在使用</span><b>${active}</b></div><div class="summary-card"><span>累计运行</span><b>${totalRuns}</b></div><div class="summary-card"><span>待查看异常</span><b class="${failed?'failed':''}">${failed}</b></div></div><div class="flow-list">${list.map(a=>{const labels=labelsFor(a.domain);const caps=(a.capabilities||[]).map(c=>`<span class="chip-tag">${capabilityLabel(c,a.domain)}</span>`).join('');const prog=a.capabilities?.includes('collect')?`<span>${labels.completedCount} ${a.submittedCount}/${a.memberCount}</span>`:'';const lastRun=a.lastRunStatus?`<span class="${a.lastRunStatus==='failed'?'failed':'success'}">${runText2[a.lastRunStatus]}</span>`:'<span class="neutral">等待第一次运行</span>';return`<article class="card flow-card" data-automation="${a.automationId}"><div><h3>${esc(a.name)}</h3><div class="meta"><span class="status ${a.status==='enabled'?'success':'neutral'}"><span class="dot" aria-hidden="true"></span>${autoStatusText[a.status]}</span>${caps}${prog}${lastRun}</div></div><button class="switch ${a.status==='enabled'?'on':''}" data-auto-toggle="${a.automationId}" aria-label="${autoStatusText[a.status]}" ${a.status==='ended'?'disabled':''}></button></article>`}).join('')}</div>`:`<div class="empty"><h2>还没有自动帮办</h2><p>挑一件你常做的事交给我，我一步步问你从什么时候开始、要怎么做。</p><button class="btn primary" data-action="create">交给我一件事</button></div>`}</div></section>`}
// P1-A：任务级详情。展示任务名/状态/能力链/名单进度/运行记录 + 启停/结束/删除/编辑。
function renderDetail(){const a=adapter.getAutomation(store.get().ui.selectedAutomationId);if(!a)return renderList();
  const labels=labelsFor(a.domain),evidence=adapter.evidence(a.automationId);
  const flowRuns=(a.flows||[]).flatMap(f=>adapter.listRuns(f.flowId)).sort((x,y)=>String(y.startedAt).localeCompare(String(x.startedAt)));
  const capChain=(a.capabilities||[]).map((c,i)=>`<div class="chain-step"><span class="step-num">${i+1}</span><span>${capabilityLabel(c,a.domain)}</span></div>`).join('');
  const canToggle=a.status==='enabled'||a.status==='paused';
  const actions=`${a.capabilities?.includes('collect')?`<button class="btn" data-action="attachment">查看${labels.progressTitle}</button>`:''}<button class="btn" data-auto-edit="${a.automationId}">编辑</button>${a.status!=='ended'&&a.status!=='deleted'?`<button class="btn" data-auto-end="${a.automationId}">结束</button>`:''}<button class="btn danger" data-auto-delete="${a.automationId}">删除</button>`;
  const evidenceCard=evidence?`<div class="card evidence-card" style="margin-top:14px"><div class="card-title-row"><div><h3>本地助手统一汇报</h3><p>${esc(evidence.summaryText)}</p></div><button class="btn primary" data-archive="${a.automationId}" ${evidence.artifacts.length?'':'disabled'}>下载一次性ZIP</button></div><div class="summary compact"><div class="summary-card">应交<b>${evidence.progress.expected}</b></div><div class="summary-card">已收<b>${evidence.progress.received}</b></div><div class="summary-card">未交<b>${evidence.progress.missing}</b></div></div>${evidence.missingMembers.length?`<p><b>未交人员</b>　${evidence.missingMembers.map(m=>esc(m.name)).join('、')}</p>`:'<p class="success">当前无未交人员</p>'}${a.remindText?`<p><b>提醒文案</b>　${esc(a.remindText)}</p>`:''}${evidence.noActionReason?`<p><b>本次无动作原因</b>　${esc(evidence.noActionReason)}</p>`:''}<h4>文件成果</h4>${evidence.artifacts.length?`<table class="table"><thead><tr><th>成员</th><th>文件</th><th>时间</th></tr></thead><tbody>${evidence.artifacts.map(file=>`<tr><td>${esc(file.memberName)}</td><td>${esc(file.name)}</td><td>${fmt(file.createdAt)}</td></tr>`).join('')}</tbody></table>`:'<p class="neutral">还没有文件成果</p>'}<h4>消息执行证据</h4>${evidence.messages.length?evidence.messages.slice(-8).reverse().map(message=>`<div class="evidence-row"><span><b>${esc(message.recipientLabel)}</b><br><small>${esc(message.text||'')}</small></span><span class="${message.deliveryStatus==='mock_recorded'?'success':'failed'}">${message.deliveryStatus==='mock_recorded'?'已发送':'失败'}<br><small>Run ${esc(message.runId.slice(-8))} · Action ${esc(message.actionId)}</small></span></div>`).join(''):'<p class="neutral">还没有消息记录</p>'}</div>`:'<div class="card" style="margin-top:14px"><p class="neutral">正在加载统一汇报……</p></div>';
  return`<section class="page">${header(`<button class="back" data-route="automations">‹ 返回</button> ${esc(a.name)}`,'自动帮办',actions)}<div class="content detail-grid"><div><div class="card"><h2>这个帮办会做什么</h2><div class="chain-label">按你的意思，我会帮你</div>${capChain}${a.deadlineAt?`<dl class="keyvals"><dt>${labels.deadline}</dt><dd>${fmt(a.deadlineAt)}</dd></dl>`:''}</div>${evidenceCard}<div class="card" style="margin-top:14px"><h3>运行记录</h3>${flowRuns.length?flowRuns.map(r=>`<div class="history-item" data-run="${r.runId}"><span><b class="${r.status==='failed'?'failed':'success'}">${runText2[r.status]||'运行'}</b><br><small>${fmt(r.startedAt)}</small></span><span>查看 ›</span></div>`).join(''):'<p class="neutral">等待第一次运行</p>'}</div></div><aside><div class="card"><h3>当前状态</h3>${canToggle?`<button class="switch ${a.status==='enabled'?'on':''}" data-auto-toggle="${a.automationId}"></button>　${autoStatusText[a.status]}`:`<span class="status neutral">${autoStatusText[a.status]}</span>`}<dl class="keyvals">${a.groupId?`<dt>${labels.scope}</dt><dd>${esc(groupDisplayName(a.groupId))}</dd>`:''}<dt>更新时间</dt><dd>${fmt(a.updatedAt)}</dd></dl></div>${(a.flows||[]).length?`<div class="card" style="margin-top:14px"><h3>演示运行</h3><p class="neutral">演示操作会产生一次真实运行记录。</p>${a.flows.map(f=>demoButtonsFor(f)).join('')}</div>`:''}</aside></div></section>`}
function demoButtonsFor(f){const capability=f.capability||((f.templateId||'').includes('publish')?'publish':(f.templateId||'').includes('collect')?'collect':'remind');const label={publish:'触发发布',collect:'模拟收到文件',remind:'推进到提醒时间'}[capability]||'运行';return`<div class="toolbar" style="margin-bottom:8px"><button class="btn primary" data-trigger="${capability}:success">${label}</button></div>`}
function demoButtons(f){const k=f.templateId.includes('publish')?'publish':f.templateId.includes('collect')?'collect':'remind';let extra=k==='collect'?`<button class="btn" data-trigger="${k}:duplicate">重复提交</button><button class="btn danger" data-trigger="${k}:mapping-fail">人员匹配失败</button>`:k==='remind'?`<button class="btn" data-trigger="${k}:no-action">没有未交人员</button>`:'';return`<div class="toolbar"><button class="btn primary" data-trigger="${k}:success">运行成功</button>${extra}</div>`}
function renderRun(){const r=adapter.getRun(store.get().ui.selectedRunId);if(!r)return renderList();const auto=adapter.getAutomation(store.get().ui.selectedAutomationId);const labels=labelsFor(auto?.domain);const errorText=r.error?.code==='PERSON_NOT_FOUND'?`没有找到这位${labels.entity}的信息`:r.error?.message;const backAuto=store.get().ui.selectedAutomationId;const sourceText=r.eventSnapshot.type==='timer_fired'?'到达设定时间':r.eventSnapshot.type==='file_received'?'收到成员私聊文件':r.eventSnapshot.type==='group_file_received'?'群里收到文件':'我发出约定消息';return`<section class="page">${header(`<button class="back" ${backAuto?`data-route="detail"`:`data-route="automations"`}>‹ 返回</button> 单次运行详情`,'运行记录')}<div class="content detail-grid"><div class="card"><h2 class="${r.status==='failed'?'failed':'success'}">${r.status==='failed'?'运行失败':r.status==='succeeded_no_action'?'成功但无动作':'运行成功'}</h2><p>${r.status==='failed'?`${errorText}。请检查${labels.recoveryTarget}后重新提交`:r.status==='succeeded_no_action'?'本次条件已检查，没有产生重复业务动作。':'所有步骤已完成。'}</p>${r.steps.map((s,i)=>`<div class="chain-step"><span class="step-num">${i+1}</span><span><b>${actionLabel(s.actionType,auto?.domain)}</b><br><small class="${s.status==='failed'?'failed':s.status==='skipped'?'neutral':'success'}">${s.status==='failed'?'执行失败':s.status==='skipped'?'因前一步结果，本步未执行':'已完成'}</small></span></div>`).join('')}</div><aside><div class="card"><h3>当次信息</h3><p class="neutral">这里显示的是当次运行时的设置和触发信息，之后的修改不会改变这条记录。</p><dl class="keyvals"><dt>开始</dt><dd>${fmt(r.startedAt)}</dd><dt>结束</dt><dd>${fmt(r.finishedAt)}</dd><dt>来源</dt><dd>${sourceText}</dd></dl></div></aside></div></section>`}
// ============================================================================
// 注：P0-C 静态大表单创建页（route createTask）与旧 renderCreate 逐步页已废弃并移除，
// 创建入口统一为首页对话流内的对话式创建（startAssist），落库走真实 createAutomationTask。
// ============================================================================
function renderAttachment(){const auto=adapter.getAutomation(store.get().ui.selectedAutomationId);const labels=labelsFor(auto?.domain);const a=(auto&&auto.taskAttachmentId&&adapter.getAttachmentById(auto.taskAttachmentId))||adapter.getAttachment();const title=auto?esc(auto.name):labels.progressTitle;const back=auto?`data-route="detail"`:`data-route="automations"`;const sub=a.members.filter(m=>m.submissionStatus==='submitted').length;return`<section class="page">${header(`<button class="back" ${back}>‹ 返回</button> ${title} · ${labels.progressTitle}`,labels.progressTitle)}<div class="content"><div class="summary"><div class="summary-card">${labels.completedCount}<b>${sub}</b></div><div class="summary-card">${labels.pendingCount}<b>${a.members.length-sub}</b></div><div class="summary-card">已提醒<b>${a.members.filter(m=>m.reminderStatus==='sent').length}</b></div></div><div class="card"><table class="table"><thead><tr><th>${labels.entityName}</th><th>${labels.entityId}</th><th>${labels.contact}</th><th>处理状态</th><th>${labels.reminder}</th><th>文件</th></tr></thead><tbody>${a.members.map(m=>`<tr><td>${esc(m.name)}</td><td>${esc(m.studentId)}</td><td>${esc(m.userId)}</td><td class="${m.submissionStatus==='submitted'?'success':'neutral'}">${m.submissionStatus==='submitted'?labels.completed:labels.pending}</td><td>${m.reminderStatus==='not_needed'?'无需提醒':m.reminderStatus==='sent'?'已提醒':'待提醒'}</td><td>${m.filePath?esc(m.filePath.split('/').pop()):'—'}</td></tr>`).join('')}</tbody></table></div></div></section>`}
// 群消息 HTML（演示对照用）。收进内部技术视图，不占用户主导航。
function groupMessagesHtml(){const messages=adapter.messages();return messages.length?messages.map(m=>`<div class="message"><span class="mini-avatar" style="width:34px;height:34px">${esc(m.from[0])}</span><div class="bubble"><b>${esc(m.from)}</b><br>${esc(m.text)}${m.file?`<div class="card" style="margin-top:8px">${icon('file','icon icon-sm')} ${esc(m.file)}</div>`:''}</div></div>`).join(''):'<div class="empty">自动帮办产生的群消息会显示在这里</div>';}
// 保留 renderGroup 作回归对照（从技术视图进入 route=group），不再作为一级入口。
function renderGroup(){const selected=adapter.getAutomation(store.get().ui.selectedAutomationId);const attachment=selected?.taskAttachmentId?adapter.getAttachmentById(selected.taskAttachmentId):adapter.getAttachment();const groupId=attachment?.groupId||store.get().draft.groupId;return`<section class="page">${header(`<button class="back" data-route="tech">${icon('close','icon icon-sm')} 返回技术视图</button> ${esc(groupDisplayName(groupId))}`,'群聊 · 演示对照数据')}<div class="content">${groupMessagesHtml()}</div></section>`}
function renderConversations(){const conversations=adapter.conversations().slice().sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));return`<section class="page">${header('最近会话','真实Mock消息记录')}<div class="content">${conversations.length?`<div class="flow-list">${conversations.map(item=>`<article class="card flow-card" data-conversation="${item.conversationId}"><div class="conversation-card-body"><h3>${esc(item.displayLabel)}</h3><div class="meta conversation-meta"><span class="conversation-preview">${esc(item.latestMessage||'暂无消息')}</span><span>${fmt(item.updatedAt)}</span></div></div><span>查看 ›</span></article>`).join('')}</div>`:'<div class="empty"><h2>还没有业务会话</h2><p>群通知、私聊提交和提醒产生后会显示在这里。</p></div>'}</div></section>`}
function renderConversation(){const id=store.get().ui.selectedConversationId;const conversation=adapter.conversations().find(item=>item.conversationId===id);const messages=adapter.conversationMessages(id);if(!conversation)return renderConversations();return`<section class="page">${header(`<button class="back" data-route="conversations">‹ 返回</button> ${conversation.kind==='group'?'班级群聊':'成员私聊'}`,'业务会话')}<div class="content"><div class="chat business-chat">${messages.length?messages.map(message=>`<div class="msg-row ${message.direction==='inbound'?'me':''}"><span class="msg-avatar ${message.direction==='inbound'?'me':'bot'}">${message.direction==='inbound'?'成':'助'}</span><div class="msg-bubble"><b>${esc(message.senderLabel)}</b><br>${esc(message.text||'')}${message.file?`<div class="file-result">${icon('file','icon icon-sm')} ${esc(message.file.name)}</div>`:''}<small class="message-status">${fmt(message.occurredAt)} · ${message.deliveryStatus==='mock_recorded'?'已记录':'已接收'}</small></div></div>`).join(''):'<div class="empty">暂无消息</div>'}</div></div></section>`}
function renderTech(){const snapshot=adapter.snapshot(),runs=adapter.listRuns(),last=runs[0];return`<section class="page tech">${header('内部技术视图','仅Demo调试使用',`<button class="btn" data-action="reset">恢复主演示初始状态</button>`)}<div class="content"><div class="toolbar" style="margin-bottom:14px"><button class="btn" data-action="seed">从当前参数保存三条帮办</button><button class="btn" data-trigger="publish:success">触发发布</button><button class="btn" data-trigger="collect:success">模拟收到文件</button><button class="btn" data-trigger="remind:success">推进到截止时间</button><button class="btn" data-route="group">查看群聊演示</button></div><div class="code-grid"><div class="code-card"><h3>JSON DSL · Flow定义</h3><pre>${esc(JSON.stringify(snapshot.flows,null,2))}</pre></div><div class="code-card"><h3>事件快照和执行步骤</h3><pre>${esc(JSON.stringify(last||{提示:'运行一次后显示事件快照和执行步骤'},null,2))}</pre></div><div class="code-card"><h3>Mock消息与文件结果</h3><pre>${esc(JSON.stringify(snapshot.adapters,null,2))}</pre></div></div></div></section>`}
function intro(){const c=COPY.intro;modal.innerHTML=`<div class="modal-mask"><div class="modal"><div class="bot-logo" style="margin:0">助</div><h2>${esc(c.title)}</h2><p>${esc(c.body)}</p><div id="introExamples"></div><div class="modal-actions"><button class="btn" data-examples>${esc(c.secondary)}</button><button class="btn primary" data-dismiss>${esc(c.primary)}</button></div></div></div>`}
// 任务级删除/结束确认弹窗。
function confirmDelete(id){modal.innerHTML=`<div class="modal-mask"><div class="modal"><h2>删除这个自动帮办？</h2><p>删除后它不会再执行，也不出现在默认列表里。已有的运行记录和名单进度都会继续保留，随时能查。</p><div class="modal-actions"><button class="btn" data-close>取消</button><button class="btn primary" data-confirm-auto-delete="${id}">确认删除</button></div></div></div>`}
function confirmEnd(id){modal.innerHTML=`<div class="modal-mask"><div class="modal"><h2>结束这个自动帮办？</h2><p>结束后它不再触发新的运行，正在进行的会做完。数据和历史都保留，可随时查看，但结束后不能再重新启用。</p><div class="modal-actions"><button class="btn" data-close>取消</button><button class="btn primary" data-confirm-auto-end="${id}">确认结束</button></div></div></div>`}
// 任务编辑弹窗（P1-A）：只放常改字段，用短表单，带 * 为必填；结构化错误就地提示。
function editModal(id,errs=[]){const a=adapter.getAutomation(id);if(!a)return;const labels=labelsFor(a.domain);const has=c=>a.capabilities?.includes(c);const err=f=>{const e=errs.filter(x=>x.field===f);return e.length?`<p class="field-error">${e.map(x=>esc(x.message)).join('；')}</p>`:''};const bad=f=>errs.some(x=>x.field===f)?' invalid':'';
  modal.innerHTML=`<div class="modal-mask"><div class="modal"><h2>编辑：${esc(a.name)}</h2>${errs.length?`<div class="error-banner">还有 ${errs.length} 处需要调整。</div>`:''}<div class="form">
  <label>任务名 *<input data-edit="taskName" class="fld${bad('taskName')}" value="${esc(a.name)}"></label>${err('taskName')}
  ${has('publish')?`<label>发布说明 *<textarea data-edit="publishText" class="fld${bad('publishText')}" placeholder="发到群里的通知正文">${esc(a.publishText||'')}</textarea></label>${err('publishText')}`:''}
  ${has('remind')?`<label>提醒文案 *<textarea data-edit="remindText" class="fld${bad('remindText')}" placeholder="${labels.remindPlaceholder}">${esc(a.remindText||'')}</textarea></label>${err('remindText')}`:''}
  ${a.deadlineAt!==null&&(has('collect')&&has('remind'))?`<label>${labels.deadline}</label><div class="choices" role="group" aria-label="${labels.deadline}">
    <button type="button" class="choice on" data-deadline-opt="">保持不变（${fmt(a.deadlineAt)}）</button>
    <button type="button" class="choice" data-deadline-opt="2026-08-05T18:00:00+08:00">改到 8月5日 18:00</button>
    <button type="button" class="choice" data-deadline-opt="2026-08-10T18:00:00+08:00">改到 8月10日 18:00</button>
  </div><input type="hidden" data-edit="deadlineAt" value="">${err('deadlineAt')}`:''}
  <div class="modal-actions"><button class="btn" data-close>取消</button><button class="btn primary" data-confirm-auto-edit="${id}">保存</button></div>
  </div></div></div>`}
function addRemindModal(id){const a=adapter.getAutomation(id);if(!a)return;const defaultAt=a.deadlineAt?new Date(a.deadlineAt).toISOString().slice(0,16):'';modal.innerHTML=`<div class="modal-mask"><div class="modal"><h2>给「${esc(a.name)}」加上催交</h2><p>会沿用当前名单和收作业记录，只新增一条催交能力。</p><div class="form"><label>提醒时间 *<input data-add-remind-field="remindAt" type="datetime-local" value="${defaultAt}"></label><label>提醒文案<textarea data-add-remind-field="remindText">请未交作业的同学尽快提交「${esc(a.name)}」。</textarea></label><div class="modal-actions"><button class="btn" data-close>取消</button><button class="btn primary" data-confirm-add-remind="${id}">保存并加入</button></div></div></div></div>`}
function captureChatScroll(){const scroller=document.querySelector('#chatScroll');if(!scroller)return;chatSavedScrollTop=scroller.scrollTop}
function restoreChatScroll(){const scroller=document.querySelector('#chatScroll');if(!scroller)return;const top=chatFollowsLatest?scroller.scrollHeight:chatSavedScrollTop;scroller.scrollTop=top;requestAnimationFrame(()=>{scroller.scrollTop=chatFollowsLatest?scroller.scrollHeight:chatSavedScrollTop})}
function scrollToLatest(){const scroller=document.querySelector('#chatScroll');if(!scroller)return;chatFollowsLatest=true;chatSavedScrollTop=scroller.scrollHeight;scroller.scrollTo({top:scroller.scrollHeight,behavior:'smooth'});document.querySelector('.latest-message')?.remove()}
function syncLatestButton(){const scroller=document.querySelector('#chatScroll');if(!scroller)return;chatSavedScrollTop=scroller.scrollTop;chatFollowsLatest=scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<=CHAT_BOTTOM_THRESHOLD;const existing=document.querySelector('.latest-message');if(chatFollowsLatest){existing?.remove();return}if(!existing){const button=document.createElement('button');button.className='latest-message';button.dataset.scrollLatest='';button.setAttribute('aria-label','回到最新消息');button.textContent='↓ 回到最新';document.querySelector('.home>.composer')?.before(button)}}
function render(){captureChatScroll();const s=store.get();document.querySelectorAll('.nav-item').forEach(x=>x.classList.toggle('active',x.dataset.route===s.ui.route||(s.ui.route==='detail'&&x.dataset.route==='automations')));const n=adapter.unreadFailures(),badge=document.querySelector('#failureBadge');badge.hidden=!n;badge.textContent=n;app.innerHTML=s.ui.route==='home'?renderHome():s.ui.route==='automations'?renderList():s.ui.route==='detail'?renderDetail():s.ui.route==='run'?renderRun():s.ui.route==='attachment'?renderAttachment():s.ui.route==='group'?renderGroup():s.ui.route==='conversations'?renderConversations():s.ui.route==='conversation'?renderConversation():renderTech();restoreChatScroll();if(!s.ui.introSeen&&!modal.innerHTML)intro()}
// 启动对话式创建：不跳页、不预设业务链路。push 开场介绍+反问，进入待意图状态。
function startAssist(){return agentStart()}
document.addEventListener('click',async e=>{const t=e.target.closest('button,[data-flow],[data-run],[data-automation],[data-conversation]');if(!t)return;try{if(t.id==='sendBtn'){sendMessage();return}
    if(t.dataset.scrollLatest!==undefined){scrollToLatest();return}
    // P1-A 任务级：进详情 / 启停 / 结束 / 删除 / 编辑
    if(t.dataset.automation!==undefined){await adapter.loadEvidence(t.dataset.automation);route('detail',{selectedAutomationId:t.dataset.automation});return}
    if(t.dataset.conversation!==undefined){await adapter.loadConversationMessages(t.dataset.conversation);route('conversation',{selectedConversationId:t.dataset.conversation});return}
    if(t.dataset.archive!==undefined){const archive=await adapter.createArchive(t.dataset.archive);const link=document.createElement('a');link.href=archive.downloadUrl;link.download=archive.fileName;document.body.append(link);link.click();link.remove();toast('已开始一次性下载，再次下载请重新生成。');return}
    if(t.dataset.autoToggle!==undefined){e.stopPropagation();const a=adapter.getAutomation(t.dataset.autoToggle);await adapter.setAutomationStatus(a.automationId,a.status==='enabled'?'paused':'enabled');toast(a.status==='enabled'?'已暂停，不会再开始新的运行。':'已恢复，条件满足时会继续帮你办。');return}
    if(t.dataset.autoEnd!==undefined){confirmEnd(t.dataset.autoEnd);return}
    if(t.dataset.confirmAutoEnd!==undefined){await adapter.setAutomationStatus(t.dataset.confirmAutoEnd,'ended');modal.innerHTML='';toast('已结束，历史和名单都保留。');return}
    if(t.dataset.autoDelete!==undefined){confirmDelete(t.dataset.autoDelete);return}
    if(t.dataset.confirmAutoDelete!==undefined){await adapter.setAutomationStatus(t.dataset.confirmAutoDelete,'deleted');modal.innerHTML='';route('automations');toast('已删除，历史和名单仍保留。');return}
    if(t.dataset.addRemind!==undefined){addRemindModal(t.dataset.addRemind);return}
    if(t.dataset.confirmAddRemind!==undefined){const id=t.dataset.confirmAddRemind;const options={};document.querySelectorAll('[data-add-remind-field]').forEach(el=>{options[el.dataset.addRemindField]=el.value.trim()});if(options.remindAt)options.remindAt=toRfc3339(options.remindAt);try{await adapter.addAutomationCapability(id,'remind',options);modal.innerHTML='';toast('已加上催交，之后会沿用当前名单提醒未交成员。')}catch(err){toast(err.message||'追加催交失败')}return}
    if(t.dataset.autoEdit!==undefined){editModal(t.dataset.autoEdit);return}
    if(t.dataset.deadlineOpt!==undefined){const box=t.closest('.choices');box.querySelectorAll('[data-deadline-opt]').forEach(b=>b.classList.toggle('on',b===t));const hidden=box.parentElement.querySelector('[data-edit="deadlineAt"]');if(hidden)hidden.value=t.dataset.deadlineOpt;return}
    if(t.dataset.confirmAutoEdit!==undefined){const id=t.dataset.confirmAutoEdit;const patch={};document.querySelectorAll('[data-edit]').forEach(el=>{const v=el.value.trim();if(v!=='')patch[el.dataset.edit]=v;});try{await adapter.editAutomation(id,patch);modal.innerHTML='';toast('改好了，下次就按新的来帮你办。');}catch(err){if(err.name==='CreationValidationError')editModal(id,err.errors);else toast(err.message||'保存失败');}return}
    // 编号选项作答
    if(t.dataset.agentTrusted!==undefined){await agentSendTrusted(t.dataset.agentTrusted);return}
    if(t.dataset.agentCustom!==undefined){await agentSendCustom(t.dataset.agentCustom);return}
    if(t.dataset.agentCandidate!==undefined){await agentChooseCandidate(t.dataset.agentCandidate);return}
    if(t.dataset.agentTime!==undefined){await agentSendTime();return}
    if(t.dataset.agentConfirm!==undefined){await agentConfirm();return}
    if(t.dataset.agentCancel!==undefined){await agentCancel();return}
    if(t.dataset.agentRetry!==undefined){const a=store.get().agent;await withAgentBusy(async()=>setAgentDraft(await adapter.getAgentDraft(a.draftId,agentAuth())));return}
    if(t.dataset.agentRedescribe!==undefined){const input=document.querySelector('#messageInput');if(input){input.focus();input.setAttribute('aria-label','重新描述想完成的目标')}return}
    if(t.dataset.agentRestart!==undefined){clearAgentSession();store.update(s=>{s.agent={active:false,busy:false,draftId:null,conversationId:null,draft:null,error:null}});await agentStart();return}
    if(t.dataset.agentReviseMenu!==undefined){store.update(s=>{s.agent.showReviseFields=!s.agent.showReviseFields});return}
    if(t.dataset.agentRevise!==undefined){await agentRevise(t.dataset.agentRevise);return}
    if(t.dataset.agentBack!==undefined){await agentBack();return}
    if(t.dataset.stepChoice!==undefined){creationAnswer(t.dataset.stepChoice,true);return}
    // 确认卡按钮
    if(t.dataset.cc!==undefined){await creationConfirm(t.dataset.cc);return}
    if(t.dataset.quick){const a=t.dataset.quick;if(a==='create')await startAssist();else if(a==='go-automations')route('automations');else if(a.startsWith('remind-now:')){const id=a.slice('remind-now:'.length);clearReminderQuick(id);pushMe('帮我催交');await remindNow(id)}else if(a.startsWith('dismiss-remind:')){const id=a.slice('dismiss-remind:'.length);clearReminderQuick(id);pushMe('暂不催交');pushBot('好，这次先不催交。')}return}if(t.dataset.route){if(t.dataset.route==='conversations')await adapter.loadConversations();route(t.dataset.route);return}
    // 创建入口统一为首页对话流内的对话式创建（startAssist）。旧 renderCreate/renderCreateTask 页已移除。
    if(t.dataset.dismissTip!==undefined){const tip=document.querySelector('#keywordTip');if(tip)tip.innerHTML='';return}
    if(t.dataset.action==='assist-start'||t.dataset.action==='create'){await startAssist();return}if(t.dataset.run){route('run',{selectedRunId:t.dataset.run});await adapter.viewRun(t.dataset.run)}if(t.dataset.close!==undefined)modal.innerHTML='';if(t.dataset.dismiss!==undefined){store.update(s=>s.ui.introSeen=true);modal.innerHTML=''}if(t.dataset.examples!==undefined)document.querySelector('#introExamples').innerHTML=`<div class="examples"><div class="example">发作业并收作业</div><div class="example">自动回复并登记</div><div class="example">定时发送通知</div><div class="example">文件改名并登记</div></div><p>选择场景后，本地助手会先和你确认什么时候开始，再一步步确认要做什么。</p>`;if(t.dataset.trigger){const[k,v]=t.dataset.trigger.split(':');if(k==='remind'){await promptDeadlineCheck()}else{const r=await adapter.trigger(k,v);toast(r?r.status==='failed'?'运行失败，已留下记录。':r.status==='succeeded_no_action'?'成功但无动作。':'运行成功。':'请先启用对应帮办')}}if(t.dataset.action==='attachment')route('attachment');if(t.dataset.action==='reset'){await adapter.reset();modal.innerHTML='';toast('已恢复主演示初始状态')}if(t.dataset.action==='seed'){for(const kind of ['publish','collect','remind'])await adapter.saveFlow(kind,'enabled');toast('三条帮办已从当前参数保存')}}catch(error){toast(error.message)}});
document.addEventListener('input',e=>{if(e.target.dataset.draft)store.update(s=>s.draft[e.target.dataset.draft]=e.target.value);if(e.target.dataset.task)store.silent(s=>s.taskDraft[e.target.dataset.task]=e.target.value);if(e.target.dataset.roster){const[idx,key]=e.target.dataset.roster.split(':');store.silent(s=>{s.taskDraft.roster[Number(idx)][key]=e.target.value})}if(e.target.id==='messageInput'){const hit=/(自动|定时|每次|以后|收到后)/.test(e.target.value);document.querySelector('#keywordTip').innerHTML=hit?`<div class="keyword-tip"><span>${esc(COPY.keywordHint.text)}</span><button class="btn" data-action="create">${esc(COPY.keywordHint.confirm)}</button><button class="btn ghost" data-dismiss-tip>${esc(COPY.keywordHint.dismiss)}</button></div>`:''}});
// 回车发送（Shift+Enter 换行）；输入框是主入口，消息在对话流内应答，不跳页。
document.addEventListener('keydown',e=>{if(e.target.id==='messageInput'&&e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage()}});store.subscribe(render);window.addEventListener('engine-state-changed',render);await adapter.init();await restoreAgentSession();render();
document.addEventListener('scroll',e=>{if(e.target.id==='chatScroll')syncLatestButton()},true);
let conversationRefreshBusy=false;
setInterval(async()=>{const s=store.get();if(conversationRefreshBusy||!['conversations','conversation'].includes(s.ui.route))return;conversationRefreshBusy=true;try{await adapter.loadConversations();if(s.ui.route==='conversation'&&s.ui.selectedConversationId)await adapter.loadConversationMessages(s.ui.selectedConversationId)}catch{}finally{conversationRefreshBusy=false}},2000);
