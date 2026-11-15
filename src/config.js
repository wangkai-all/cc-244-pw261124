// 全部数据均为虚构，仅用于本地权限边界演练；不包含任何真实客户资料。
export const DATASET = {
  id: 'customers',
  name: '虚构客户主数据集',
  revision: 4,
  description: '24 条本地生成的演练记录，字段敏感度分层；来源与接收端都不访问外部网络。',
  updatedAt: '2026-11-10T09:00:00.000Z'
};

export const FIELDS = [
  { key: 'customer_id', label: '客户编号', sensitivity: 'low', kind: 'id' },
  { key: 'full_name', label: '姓名', sensitivity: 'medium', kind: 'text' },
  { key: 'email', label: '邮箱', sensitivity: 'medium', kind: 'text' },
  { key: 'phone', label: '电话', sensitivity: 'high', kind: 'text' },
  { key: 'city', label: '城市', sensitivity: 'low', kind: 'text' },
  { key: 'plan', label: '套餐', sensitivity: 'low', kind: 'text' },
  { key: 'monthly_spend', label: '月消费', sensitivity: 'medium', kind: 'number' },
  { key: 'health_note', label: '健康备注', sensitivity: 'high', kind: 'text' },
  { key: 'support_notes', label: '支持备注', sensitivity: 'high', kind: 'text' }
];

export const FIELD_MAP = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

const NAMES = [
  '林雾', '周岚', '陈屿', '苏澄', '郑禾', '许棠', '沈砚', '何栩',
  '顾遥', '江昭', '温宁', '梁栖', '宋汀', '叶澜', '唐柚', '陆弦',
  '白榆', '韩荔', '秦川', '夏柘', '程洱', '孟樾', '薛棠', '裴舟'
];
const PINYIN = [
  'lin.wu', 'zhou.lan', 'chen.yu', 'su.cheng', 'zheng.he', 'xu.tang', 'shen.yan', 'he.xu',
  'gu.yao', 'jiang.zhao', 'wen.ning', 'liang.qi', 'song.ting', 'ye.lan', 'tang.you', 'lu.xian',
  'bai.yu', 'han.li', 'qin.chuan', 'xia.zhe', 'cheng.er', 'meng.yue', 'xue.tang', 'pei.zhou'
];
const CITIES = ['杭州', '苏州', '成都', '厦门', '南京', '青岛', '武汉', '宁波'];
const PLANS = ['starter', 'standard', 'pro', 'enterprise'];

function makeRows() {
  return NAMES.map((name, i) => {
    const n = String(i + 1).padStart(2, '0');
    const id = `C-30${n}`;
    return {
      customer_id: id,
      full_name: `${name}（虚构）`,
      email: `${PINYIN[i]}@example.test`,
      phone: `138-0000-30${n}`,
      city: CITIES[i % CITIES.length],
      plan: PLANS[i % PLANS.length],
      monthly_spend: 120 + ((i * 137) % 880),
      health_note: `虚构健康标记-H${n}：仅用于演练`,
      support_notes: `虚构支持备注-S${n}：优先回访`
    };
  });
}

export const ROWS = makeRows();
export const ROW_COUNT = ROWS.length;
export const CHUNK_SIZE = 4;
export const CHUNK_COUNT = Math.ceil(ROW_COUNT / CHUNK_SIZE);

export const PURPOSES = {
  billing: {
    key: 'billing',
    label: '账单核对',
    description: '核对套餐、消费与客户联系信息；排除城市、健康与支持备注。',
    allowedFields: ['customer_id', 'full_name', 'email', 'plan', 'monthly_spend'],
    defaultFields: ['customer_id', 'full_name', 'email', 'plan', 'monthly_spend']
  },
  analytics: {
    key: 'analytics',
    label: '用量分析',
    description: '聚合城市与消费分层；不接触姓名、电话、邮箱或备注。',
    allowedFields: ['customer_id', 'city', 'plan', 'monthly_spend'],
    defaultFields: ['customer_id', 'city', 'plan', 'monthly_spend']
  },
  care: {
    key: 'care',
    label: '客户关怀',
    description: '回访需要联系方式和支持备注；不接触消费金额与健康备注。',
    allowedFields: ['customer_id', 'full_name', 'phone', 'email', 'support_notes'],
    defaultFields: ['customer_id', 'full_name', 'phone', 'email', 'support_notes']
  }
};

export const PURPOSE_LIST = Object.values(PURPOSES);

export const POLICY = {
  chunkRows: CHUNK_SIZE,
  chunkCount: CHUNK_COUNT,
  tokenTtlSeconds: 300,
  reuse: [
    '块必须完整接收、长度与内容哈希校验通过；半包字节直接丢弃，不做跨版本拼接。',
    '块内每一列都必须仍属当前用途授权，且该列的授权纪元（epoch）与当前一致。',
    '块必须覆盖任务所需的全部字段；缺列（例如撤权后又重新授权）只能整块重取。',
    '块的数据集修订号必须与来源当前修订号一致；否则整块失效。'
  ],
  publication: [
    '发布前在同一事务内复核用途字段、各列纪元、数据集修订号与任务栅栏。',
    '索引提交采用比较并交换：构建期间授权版本变化则构建作废，不发布旧范围。',
    '查询每次按当前授权逐列复核，缺列时遮蔽；导出要求索引完整覆盖当前授权，否则拒绝。',
    '撤权时在同一事务内从块与索引副本中清除对应列，并写入不可逆的清除墓碑。'
  ]
};
