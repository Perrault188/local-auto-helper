import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url);
const source = name => readFile(new URL(name, root), 'utf8');
const memoryStorage = () => {
  const values = new Map();
  return { getItem:key=>values.get(key)??null, setItem:(key,value)=>values.set(key,String(value)), removeItem:key=>values.delete(key), values };
};
globalThis.localStorage = memoryStorage();
globalThis.sessionStorage = memoryStorage();
globalThis.window = { dispatchEvent(){} };
globalThis.CustomEvent = class { constructor(type){this.type=type} };

test('B3使用Agent草稿API并以revision、planHash和会话凭据确认', async () => {
  const adapter = await source('prototype/adapter.js');
  for (const endpoint of [
    '/api/agent/drafts',
    '/messages',
    '/choose-candidate',
    '/context-options',
    '/revise',
    '/back',
    '/confirm',
    '/cancel'
  ]) assert.match(adapter, new RegExp(endpoint.replaceAll('/', '\\/')));
  assert.match(adapter, /x-agent-conversation-id/);
  assert.match(adapter, /x-agent-draft-token/);
  assert.match(adapter, /revision:\s*draft\.revision/);
  assert.match(adapter, /planHash:\s*await browserPlanHash/);
});

test('草稿token不进入URL、日志或localStorage', async () => {
  const [app, adapter, store] = await Promise.all([
    source('prototype/app.js'), source('prototype/adapter.js'), source('prototype/store.js')
  ]);
  assert.doesNotMatch(app, /console\.(?:log|info|debug)\([^)]*draftToken/);
  assert.doesNotMatch(adapter, /encodeURIComponent\(.*draftToken/);
  assert.match(store, /delete safe\.agent\.draftToken/);
  assert.match(store, /delete safe\.agent\.draft/);
});

test('store.update和silent都经过同一安全序列化，凭据只进入sessionStorage', async () => {
  const module = await import(`../prototype/store.js?runtime=${Date.now()}`);
  module.store.update(state => { state.agent.draftToken='secret-update';state.agent.draft={private:true}; });
  assert.doesNotMatch(localStorage.getItem('local-auto-helper-prototype-0.2-rc1'), /secret-update|private/);
  module.store.silent(state => { state.agent.draftToken='secret-silent';state.agent.draft={privateAgain:true}; });
  assert.doesNotMatch(localStorage.getItem('local-auto-helper-prototype-0.2-rc1'), /secret-silent|privateAgain/);
  module.saveAgentSession({draftId:'d1',conversationId:'c1',draftToken:'session-secret'});
  assert.match(sessionStorage.getItem('local-auto-helper-agent-session'), /session-secret/);
  assert.doesNotMatch(localStorage.getItem('local-auto-helper-prototype-0.2-rc1'), /session-secret/);
  module.clearAgentSession();
  assert.equal(module.loadAgentSession(), null);
});

test('adapter运行时只提交optionId，并调用候选、返回和修改端点', async () => {
  const calls=[];
  globalThis.fetch=async(path,options={})=>{calls.push({path,options});return{ok:true,status:200,json:async()=>path.endsWith('context-options')?{options:[{optionId:'o1',field:'groupId',label:'群'}]}:{draft:{draftId:'d1'}}}};
  const { adapter }=await import(`../prototype/adapter.js?runtime=${Date.now()}`);
  const auth={conversationId:'c1',draftToken:'t1'};
  await adapter.agentContextOptions('d1',auth);
  await adapter.chooseAgentCandidate('d1','candidate_abc',auth);
  await adapter.backAgentDraft('d1',auth);
  await adapter.reviseAgentDraft('d1','taskName',auth);
  await adapter.messageAgentDraft('d1',{contextOptionIds:['o1']},auth);
  assert.deepEqual(calls.map(call=>call.path),[
    '/api/agent/drafts/d1/context-options','/api/agent/drafts/d1/choose-candidate',
    '/api/agent/drafts/d1/back','/api/agent/drafts/d1/revise','/api/agent/drafts/d1/messages'
  ]);
  assert.deepEqual(JSON.parse(calls.at(-1).options.body),{contextOptionIds:['o1']});
  assert.equal(calls.at(-1).options.headers['x-agent-draft-token'],'t1');
  assert.deepEqual(JSON.parse(calls[1].options.body),{candidateId:'candidate_abc'});
});

test('受控字段使用受控选项，触发方式、文件规则、改名格式和回复自定义值走服务端校验', async () => {
  const app = await source('prototype/app.js');
  const adapter = await source('prototype/adapter.js');
  assert.match(app, /CONTROLLED_FIELDS=new Set\(\['groupId','noticeFilePath','publishTrigger','collectRule','nameTemplate','roster','replyText','remindText','submitters','stores'\]\)/);
  assert.match(app, /type="datetime-local"/);
  assert.match(app, /toRfc3339/);
  assert.match(app, /\['groupId','collectRule','nameTemplate','replyText','remindText'\]\.includes\(field\)/);
  assert.match(app, /data-agent-custom/);
  assert.match(adapter, /\/custom-context/);
  assert.match(app, /这一项请使用上方的受控选择器/);
});

test('确认卡以用户能理解的步骤呈现，并保留降级说明及财务人工审核边界', async () => {
  const app = await source('prototype/app.js');
  for (const text of ['启用前确认','本地助手会这样帮你','查看运行说明','启用后可以在自动帮办页暂停、恢复或修改']) assert.match(app, new RegExp(text));
  for (const action of ['启用这条帮办','修改设置','上一步','取消']) assert.match(app, new RegExp(action));
  assert.match(app, /按明确规则识别/);
  assert.match(app, /智能理解暂时不可用/);
  assert.match(app, /进入待审核清单/);
  assert.match(app, /不会自动审核、付款或入账/);
  assert.match(app, /publishKeyword/);
  assert.match(app, /collectRuleSummary/);
  assert.match(app, /nameTemplateSummary/);
  assert.match(app, /replyText/);
  assert.match(app, /data-agent-revise-menu/);
  assert.match(app, /fieldText/);
});

test('管理页、常驻输入框及异常恢复入口继续存在', async () => {
  const app = await source('prototype/app.js');
  assert.match(app, /id="messageInput"/);
  assert.match(app, /function renderList/);
  assert.match(app, /function renderDetail/);
  assert.match(app, /error\.status===401/);
  assert.match(app, /error\.status===409/);
  assert.match(app, /adapter\.getAgentDraft\(a\.draftId,agentAuth\(\)\)/);
  assert.match(app, /已恢复到最新内容/);
  assert.match(app, /d\.status==='compiling'/);
  assert.match(app, /继续完成创建/);
  assert.match(app, /data-agent-confirm/);
  assert.match(app, /restoreAgentSession/);
  assert.match(app, /if\(store\.get\(\)\.agent\.busy\)return/);
});

test('unsupported只显示安全边界与重新描述入口，不显示确认卡', async () => {
  const app = await source('prototype/app.js');
  assert.match(app, /d\.status==='unsupported'/);
  assert.match(app, /这件事目前还不能按你的原意完整办好/);
  assert.match(app, /没有创建任何自动帮办，也没有发送消息或执行其他动作/);
  assert.match(app, /data-agent-redescribe/);
  assert.match(app, /d\.revision===0\|\|d\.status==='unsupported'\?\{message:text\}:\{userAnswer:text\}/);
  assert.match(app, /\['compiled','cancelled','expired','unsupported'\]\.includes\(draft\.status\)/);
});

test('受控步骤明确展示问题、演示选项来源和带字段名的回答', async () => {
  const app = await source('prototype/app.js');
  assert.match(app, /请选择一项，也可以填写自己的内容/);
  assert.match(app, /请选择一项。/);
  assert.match(app, /pushBot\(nextQuestion\.text\)/);
  assert.match(app, /fieldText\[d\.pendingQuestion\?\.field\].*choice\.label/);
  assert.match(app, /fieldText\[field\].*fmt\(value\)/);
});

test('首页输入框固定在内容区底部并保留安全间距', async () => {
  const css = await source('prototype/styles.css');
  assert.match(css, /\.home\{height:100%;min-height:0;overflow:hidden/);
  assert.match(css, /\.home>\.content\{flex:1;min-height:0;overflow:auto/);
  assert.match(css, /\.home \.content>#stepOptions\{/);
  assert.match(css, /\.home>\.composer\{flex:0 0 auto;margin-bottom:18px\}/);
});

test('聊天接近底部时跟随最新，上滚后保留位置并提供回到最新', async () => {
  const app = await source('prototype/app.js');
  const css = await source('prototype/styles.css');
  assert.match(app, /CHAT_BOTTOM_THRESHOLD=96/);
  assert.match(app, /function captureChatScroll\(\)\{[^}]*chatSavedScrollTop=scroller\.scrollTop\}/);
  assert.match(app, /chatFollowsLatest\?scroller\.scrollHeight:chatSavedScrollTop/);
  assert.match(app, /data-scroll-latest/);
  assert.match(app, /id="chatScroll"[\s\S]*id="chatFlow"[\s\S]*id="stepOptions"/);
  assert.match(css, /\.latest-message\{/);
});

test('确认卡按能力分别描述开始条件和用户可见结果', async () => {
  const app=await source('prototype/app.js');
  assert.match(app, /caps\.includes\('publish'\)[\s\S]*发送到/);
  assert.match(app, /caps\.includes\('collect'\)[\s\S]*核对成员并登记提交状态/);
  assert.match(app, /检查未交名单，并先问你是否需要催交/);
  assert.match(app, /caps\.includes\('remind'\)[\s\S]*找出未完成的人并发送提醒/);
  assert.match(app, /收好单据并放入待审核清单/);
});

test('用户发送过消息后首页输入框不再显示引导占位文案', async () => {
  const app=await source('prototype/app.js');
  assert.match(app, /chat\.some\(message=>message\.from==='me'\)\?'':COPY\.inputPlaceholder/);
  assert.match(app, /placeholder="\$\{esc\(placeholder\)\}"/);
});

test('所有store写入路径都不得把Agent明文token写入localStorage', async () => {
  const values = new Map();
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
  const { store } = await import(`../prototype/store.js?qa-token-${Date.now()}`);
  store.update(state => {
    state.agent.active = true;
    state.agent.draftToken = 'qa-secret-draft-token';
    state.agent.draft = { draftId: 'agentdraft_qa' };
  });
  assert.doesNotMatch([...values.values()].join(''), /qa-secret-draft-token/);

  store.silent(state => {
    state.groups = [{ groupId: 'group_qa', name: 'QA群' }];
  });
  assert.doesNotMatch([...values.values()].join(''), /qa-secret-draft-token/);
  delete globalThis.localStorage;
});

test('刷新后的Agent草稿有明确恢复策略，不得留下不可恢复的半活跃状态', async () => {
  const store = await source('prototype/store.js');
  assert.doesNotMatch(
    store,
    /saved\.agent\?\.draftId\?'为保护设置凭据，刷新后请重新开始/,
    '刷新后仅保留draftId/conversationId但丢失token，无法读取、取消或恢复服务端草稿'
  );
});
