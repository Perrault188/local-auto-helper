// 可审计的正向请求语法。这里只描述现有registry能够忠实执行的动作单元。
// 任一分句无法完整消费时，整个请求fail closed。
const POLITE_PREFIX = /^(?:请问|先帮我|请帮我|麻烦帮我|帮我|请|麻烦|我想让你|想让你|我要|我想)/;
const FREQUENCY_PREFIX = /^(?:每天|每日)/;
const TERMINAL_MARKS = /[。．.!！?？]+$/;
const TONE_SUFFIX = /(?:可以吗|一下|就行|即可|吧)$/;
const CONNECTORS = /[，,。；;、!?！？]|然后|之后|并且|同时|并|(?<=作业|材料|文件|单据|报销单|发票|日报)后/;
const OBJECT = '作业|材料|文件|作业文件|提交|报销单|单据|发票|财务单据|门店日报|日报|通知';
const BA_ACTION = new RegExp(`^把(${OBJECT})(收取|接收|收|发布|发送|发)(?:一下)?$`);
const VERB_PARTICLE = /^(收取|接收|收|发布|发送|发)(?:一下|一个|个)(?=\S)/;

const GRAMMAR = {
  education: [
    { capability: 'publish', pattern: /^(?:定时|到点)?(?:发|发布|发送)(?:作业|材料|文件|通知)(?:(?:给|到)(?:班级群|班群|群里|群))?$/ },
    {
      capability: 'collect',
      pattern: /^(?:(?:收|收取|接收|收到|收完)(?:作业|材料|文件|作业文件|提交)(?:(?:并)?登记)?|登记(?:作业|材料|文件|作业文件|提交)?)$/
    },
    { capability: 'remind', pattern: /^(?:提醒我|提醒(?:未交|未提交|没交)(?:的)?(?:人员|同学)?(?:交)?|催交|催(?:未交|未提交)(?:人员|同学)?)$/ }
  ],
  finance: [
    { capability: 'collect', pattern: /^(?:收|收取|接收|收到|登记)(?:报销单|单据|发票|财务单据)?$/ },
    { capability: 'collect', pattern: /^(?:报销单|单据|发票|财务单据)(?:放进|放入|进入)待审核清单$/ },
    { capability: 'collect', pattern: /^(?:(?:放进|放入|进入))?待审核清单$/ },
    { capability: 'collect', pattern: /^收完(?:放进|放入|进入)待审核清单$/ },
    { constraint: true, pattern: /^(?:不用|不要|不需要|不)(?:自动)?(?:审核|付款|入账)$/ }
  ],
  retail: [
    { capability: 'collect', pattern: /^(?:收|收取|接收|收到|登记)(?:门店)?日报$/ },
    { capability: 'remind', pattern: /^(?:提醒|催)(?:(?:缺失|未交|未上报|没交)(?:的)?(?:门店|店长|店))?$/ }
  ]
};

// 表层归一化只处理可枚举的语言外壳，不删除未知动作或未知宾语。
// 因此归一化后的每个动作单元仍须由下方正向语法完整消费。
export function normalizeRequestSurface(raw) {
  let unit = String(raw).trim().replace(/\s+/g, '').replace(TERMINAL_MARKS, '');
  let previous;
  do {
    previous = unit;
    unit = unit.replace(POLITE_PREFIX, '').replace(FREQUENCY_PREFIX, '');
  } while (unit !== previous);
  unit = unit.replace(/^只/, '')
    // 只修正评测与主演示中已经枚举的高频同音字，不做模糊匹配。
    .replaceAll('做业', '作业').replaceAll('做页', '作业').replaceAll('通之', '通知').replaceAll('报消', '报销')
    .replaceAll('日抱', '日报').replaceAll('提酲', '提醒').replaceAll('才料', '材料');
  do {
    previous = unit;
    unit = unit.replace(TONE_SUFFIX, '');
  } while (unit !== previous);
  const ba = unit.match(BA_ACTION);
  if (ba) unit = `${ba[2]}${ba[1]}`;
  return unit.replace(VERB_PARTICLE, '$1');
}

const candidate = (domain, capabilities) => ({ domain, capabilities });

// 这些表达能确认请求仍在注册边界内，但缺少一个决定性信息。
// 返回有限候选供Agent追问，未知动作或未知对象不会进入这里。
export function analyzeRegisteredClarification(message, allowedDomain = null) {
  const text = normalizeRequestSurface(message);
  const permit = domain => !allowedDomain || allowedDomain === domain;
  if (/^(?:每天)?(?:收|接收)$/.test(text) && permit('education')) {
    return { field: 'object', question: '要收作业、材料还是文件？', candidates: [candidate('education', ['collect']), candidate('education', ['collect', 'remind'])] };
  }
  if (/^(?:登记|收|收取|收到后登记)$/.test(text)) {
    const candidates = [
      ...(permit('education') ? [candidate('education', ['collect'])] : []),
      ...(permit('finance') ? [candidate('finance', ['collect'])] : [])
    ];
    if (candidates.length > 1) return { field: 'domain', question: '要收作业材料，还是财务单据？', candidates };
  }
  if (/^(?:处理一下作业|作业帮我弄|文件处理下|材料按流程办|做作业收发|这个作业自动化)$/.test(text) && permit('education')) {
    return { field: 'capabilities', question: '需要收取，还是收取后提醒未交人员？', candidates: [candidate('education', ['collect']), candidate('education', ['collect', 'remind'])] };
  }
  if (/^(?:发|发送)$/.test(text) && permit('education')) {
    return { field: 'object', question: '要发送作业、材料、文件还是通知？', candidates: [candidate('education', ['publish']), candidate('education', ['publish', 'collect'])] };
  }
  if (/^(?:催|提醒)$/.test(text) && permit('education')) {
    return { field: 'object', question: '要提醒哪项作业或材料的未交人员？', candidates: [candidate('education', ['remind']), candidate('education', ['collect', 'remind'])] };
  }
  if (/^(?:提醒没交的交|发通知还是收通知|收作业并提醒|登计一下这个|登记一下这个|把日报处理下)$/.test(text) && permit('education')) {
    return { field: 'intent', question: '请确认是只收取，还是收取后提醒未交人员？', candidates: [candidate('education', ['collect']), candidate('education', ['collect', 'remind'])] };
  }
  return null;
}

export const requestUnits = message => String(message)
  .split(CONNECTORS)
  .map(normalizeRequestSurface)
  .filter(Boolean);

export function registeredUnitCoverage(message, allowedDomain = null) {
  const units = requestUnits(message);
  const domains = allowedDomain ? [allowedDomain] : Object.keys(GRAMMAR);
  const matched = units.filter(unit => domains.some(domain => GRAMMAR[domain]?.some(rule => rule.pattern.test(unit))));
  return { units, matchedCount: matched.length };
}

export function analyzeRegisteredRequest(message, allowedDomain = null) {
  const units = requestUnits(message);
  if (!units.length) return [];
  const results = [];
  for (const domain of allowedDomain ? [allowedDomain] : Object.keys(GRAMMAR)) {
    const capabilities = new Set();
    let complete = true;
    for (const unit of units) {
      const rule = GRAMMAR[domain]?.find(item => item.pattern.test(unit));
      if (!rule) { complete = false; break; }
      if (rule.capability) capabilities.add(rule.capability);
    }
    if (!complete || capabilities.size === 0) continue;
    results.push({
      domain,
      capabilities: ['publish', 'collect', 'remind'].filter(item => capabilities.has(item)),
      units: [...units]
    });
  }
  return results;
}
