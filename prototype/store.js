const KEY='local-auto-helper-prototype-0.2-rc1';
// 创建草稿字段与引擎的createAutomationTask输入保持一致。
// 不再写死固定作业名/截止时间/花名册——初始给空或最小占位，用户输入什么就提交什么。
export const emptyTaskDraft=()=>({
  taskName:'',                       // 任务名（必填，≤80）
  groupName:'',                      // 目标群显示名（仅前端展示用）
  groupId:'',                        // 目标群标识（必填）
  publishText:'',                    // 发布说明正文（必填）
  noticeFilePath:'',                 // 通知附件引用路径（必填）
  publishAt:'',                      // 发布时间 RFC3339 带时区（必填）
  deadlineAt:'',                     // 截止时间 RFC3339 带时区，须晚于发布（必填）
  allowedExtensions:'',              // 收取扩展名白名单，逗号/空格分隔，形如 .docx,.pdf（必填）
  collectKeyword:'',                 // 收取关键词（可选）
  nameTemplate:'{studentId}_{name}{originalExtension}', // 命名模板（可选，默认值即契约默认）
  remindText:'',                     // 催交文案（必填）
  publishKeyword:'',                 // 触发关键词（可选，空则默认用任务名）
  roster:[{userId:'',name:'',studentId:''}] // 名单（必填，至少一行）
});
export const initialState=()=>({
  ui:{introSeen:false,route:'home',selectedFlowId:null,selectedAutomationId:null,selectedRunId:null,selectedConversationId:null,creationStep:0,creationPhase:'publish',toast:null},
  // 对话式创建会话态（阶段三外壳）：全程在首页对话流内，输入框常驻。
  // active 开启后 phase=null 表示"待用户表达意图"，绝不预设具体业务链路；
  // 意图明确后才置 phase='publish'|'collect'|'remind'。awaiting: intent|choice|text|confirm。
  // A2 彻底档：creation 增加 intent（用户意图）、capabilities（按意图裁剪要建的能力）、
  // planIndex（当前在能力序列里的第几条）。phase 由 capabilities 序列驱动，不再写死三条。
  creation:{active:false,phase:null,step:0,awaiting:null,askField:null,intent:null,capabilities:[],planIndex:0},
  agent:{active:false,busy:false,draftId:null,conversationId:null,draft:null,error:null},
  groups:[],
  draft:{scenario:null,triggerMode:'self_message',keyword:'发布本周作业',groupId:'',publishAt:'2026-07-21T10:00:00+08:00',notice:'请大家在7月25日18点前提交本周作业。',filePath:'/demo/source/软件工程第3周作业.pdf',taskName:'软件工程第3周作业',deadlineAt:'2026-07-25T18:00:00+08:00',remindAt:'2026-07-25T18:00:00+08:00',rosterPath:'fixtures/demo-seed.json',allowedExtensions:['.docx','.pdf'],fileKeyword:'作业',nameTemplate:'{studentId}_{name}{originalExtension}',replyText:'收到，已帮你登记',reminderText:'本周作业即将截止，请尽快提交。'},
  taskDraft:emptyTaskDraft(),        // 真实创建草稿
  taskErrors:[],                     // 结构化创建错误 [{field,code,message,row?,index?}]
  // 首页对话流：输入框主入口发出的消息与 Q 宝应答都在此承接（本轮本地规则应答）。
  // from: 'me' | 'bot'；quick: 可选快捷选项 [{label, action}]，为后续对话式创建承接留位。
  chat:[{from:'bot',text:'一些琐碎的小事都可以交给我，比如收到文件帮你登记好，或者到点提醒还没交的人。'},{from:'bot',text:'想让我帮你做点什么？'}]
});
let state=load();const listeners=new Set();
// 与 initialState 浅合并，保证旧缓存补齐新增字段（taskDraft/taskErrors）。
function load(){try{const raw=localStorage.getItem(KEY);const base=initialState();if(!raw)return base;const saved=JSON.parse(raw);return{...base,...saved,ui:{...base.ui,...saved.ui},taskDraft:{...emptyTaskDraft(),...(saved.taskDraft||{})},taskErrors:saved.taskErrors||[],chat:Array.isArray(saved.chat)&&saved.chat.length?saved.chat:base.chat,creation:{...base.creation,...(saved.creation||{})},agent:base.agent}}catch{return initialState()}}
export function safePersistentState(value){const safe=structuredClone(value);if(safe.agent){delete safe.agent.draftToken;delete safe.agent.draft;safe.agent.busy=false;}return safe}
function persist(){localStorage.setItem(KEY,JSON.stringify(safePersistentState(state)));listeners.forEach(fn=>fn(state))}
function persistSilent(){localStorage.setItem(KEY,JSON.stringify(safePersistentState(state)))}
const AGENT_SESSION_KEY='local-auto-helper-agent-session';
export function saveAgentSession(value){sessionStorage.setItem(AGENT_SESSION_KEY,JSON.stringify(value))}
export function loadAgentSession(){try{return JSON.parse(sessionStorage.getItem(AGENT_SESSION_KEY))}catch{return null}}
export function clearAgentSession(){sessionStorage.removeItem(AGENT_SESSION_KEY)}
export function clearBrowserState(){localStorage.removeItem(KEY);clearAgentSession();state=initialState();persist()}
// silent：只改数据并写入 localStorage，不触发订阅者重渲染（用于输入时避免丢焦点）。
export const store={get:()=>state,update(fn){fn(state);persist()},silent(fn){fn(state);persistSilent()},replace(next){state=next;persist()},reset(){state=initialState();persist()},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)}};
